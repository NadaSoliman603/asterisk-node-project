/**
 * Per-call orchestrator: bridges Asterisk audio with something on our side.
 *
 * Two modes, feature-flagged from ari.js:
 *
 *   startEchoCall (Phase 3) — RTP loopback. Caller hears themselves. Proves
 *   the audio plumbing (UDP socket, ExternalMedia, Bridge, cleanup).
 *
 *   startAiCall (Phase 4)   — Real conversation. Inbound RTP → OpenAI Realtime
 *   WebSocket. OpenAI response audio → outbound RTP (paced at 20 ms). Tool
 *   calls dispatched via services/tools.js against the Byit backend. Memory +
 *   summary re-injected from context-manager on each call so a returning
 *   caller (same E.164) picks up where they left off.
 *
 * Wiring per call (both modes share steps 1–6; only step 7 differs):
 *   1. Allocate a UDP port from the pool.
 *   2. Bind a UDP socket on 0.0.0.0:<port>.
 *   3. Answer the caller.
 *   4. Create a mixing Bridge.
 *   5. Create an ExternalMedia channel pointed at HOSTNAME:<port>.
 *   6. Add caller + externalMedia to the bridge (audio starts flowing).
 *   7. Wire the message handlers (echo-back OR OpenAI forward).
 *   8. On StasisEnd / error / max-duration: destroy every resource, release
 *      the port back to the pool, close the OpenAI WS if any.
 *
 * All resources are released even when setup fails partway.
 */

import dgram from 'node:dgram';
import { parseRtpPacket, buildRtpPacket, randomSsrc } from './rtp.js';
import { createRealtimeSession } from './openaiRealtime.js';
import { buildToolset, handleToolCall } from './services/tools.js';
import {
  buildRealtimeContext,
  recordUserTurn,
  recordAssistantTurn,
} from './services/context-manager.service.js';
import { addMessage, getOrCreateSession } from './store/conversationStore.js';
import { clearRawForSession } from './backend/cache.js';
import {
  EGYPT_COUNTRY,
  REALTIME_VOICE,
  REALTIME_SPEED,
  TRANSCRIBE_MODEL,
  TRANSCRIBE_LANGUAGE,
} from './constants/index.js';
import { safeJsonParse } from './utils/index.js';

// Address Asterisk uses to reach us. Inside Docker Compose this is the
// node-app service name (Docker's embedded DNS resolves it on pbx-net).
// Override with AI_MEDIA_HOSTNAME when running outside compose.
const HOSTNAME = process.env.AI_MEDIA_HOSTNAME || 'node-app';

const PORT_MIN = parseInt(process.env.EXTERNAL_MEDIA_RTP_PORT_MIN || '10500', 10);
const PORT_MAX = parseInt(process.env.EXTERNAL_MEDIA_RTP_PORT_MAX || '10599', 10);

// Per-call guardrails.
const MAX_CALL_SECONDS = parseInt(process.env.AI_MAX_CALL_SECONDS || '600', 10);
const MAX_TOOL_CALLS = parseInt(process.env.AI_MAX_TOOL_CALLS_PER_CALL || '10', 10);

// slin16 = signed linear 16-bit PCM @ 16 kHz mono. Asterisk sends 20 ms frames
// (320 samples = 640 bytes payload). RTP timestamp increments by SAMPLES per
// packet, not bytes — hence 320.
const SAMPLE_RATE_HZ = 16000;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE_HZ * FRAME_MS) / 1000; // 320
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2;                // 640 (16-bit)

// Server-side VAD is the phone equivalent of push-to-talk: OpenAI detects
// end-of-utterance from silence. Tunables can migrate to env later.
const SERVER_VAD = Object.freeze({
  type: 'server_vad',
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 600,
});

// Phone-mode postscript — appended to the reused voice prompt. Keeps
// prompts.js identical to the browser copy while giving the model
// telephony-specific guardrails.
const PHONE_MODE_POSTSCRIPT = `

━━━━━━━━━━━━━━━━━━━━
PHONE CALL MODE (HIGHEST PRIORITY)
━━━━━━━━━━━━━━━━━━━━

You are speaking on a LIVE PHONE CALL. The caller cannot see any screen.
- Never say "as you can see", never refer to buttons, screens, images, links, or on-screen items.
- Speak in short sentences suitable for a phone conversation.
- Never spell out URLs, long codes, or IDs.
- Telephony audio can be poor. If you miss a word, ask the caller to repeat rather than guessing.
- If the caller asks for a human, a callback, a sales representative, or a live agent, immediately call the request_unit_selection tool — do not try to keep the conversation going yourself.
`.trim();

const DEFAULT_GREETING_INSTRUCTION =
  process.env.AI_GREETING_INSTRUCTION ||
  'Greet the caller very briefly in Egyptian Arabic (one short sentence, mention you are Requ from Byit) and ask how you can help with their real-estate search today.';

// ── Port pool ────────────────────────────────────────────────────────────
const availablePorts = new Set();
for (let p = PORT_MIN; p <= PORT_MAX; p++) availablePorts.add(p);

/** @type {Map<string, BridgeState>} */
const activeBridges = new Map();

function allocatePort() {
  const it = availablePorts.values().next();
  if (it.done) throw new Error(`no free RTP ports in ${PORT_MIN}-${PORT_MAX}`);
  availablePorts.delete(it.value);
  return it.value;
}

function releasePort(port) {
  if (Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX) {
    availablePorts.add(port);
  }
}

function log(...args) {
  console.log('[bridge]', ...args);
}

/**
 * @typedef {Object} BridgeState
 * @property {string} channelId
 * @property {number} port
 * @property {string} mode                              'echo' | 'ai'
 * @property {import('dgram').Socket|null} socket
 * @property {any|null} bridge
 * @property {any|null} externalMedia
 * @property {number} outboundSeq
 * @property {number} outboundTs
 * @property {number} outboundSsrc
 * @property {{address: string, port: number}|null} remoteRinfo
 * @property {number} packetsIn
 * @property {number} packetsOut
 * @property {boolean} cleaned
 * @property {any|null} session                         OpenAIRealtimeSession (ai only)
 * @property {OutboundRtpPacer|null} pacer              (ai only)
 * @property {NodeJS.Timeout|null} hardTimer            max-call-duration guard (ai only)
 * @property {number} toolCallCount                     (ai only)
 * @property {any|null} toolRegistry                    (ai only)
 * @property {string|null} userId                       caller E.164 or anon_<id>
 */

// ─────────────────────────────────────────────────────────────────────────
// OutboundRtpPacer
//
// OpenAI streams audio deltas in irregular chunks (a few kB at a time).
// Asterisk expects steady 20 ms RTP packets. This queues incoming PCM and
// drains one frame per tick with monotonic seq/ts.
//
// When the queue is empty (silence between assistant utterances) we simply
// skip the tick — Asterisk tolerates gaps and plays silence. Cheaper than
// synthesising silent frames, and no worse acoustically.
// ─────────────────────────────────────────────────────────────────────────

class OutboundRtpPacer {
  constructor({ socket, getRemote, ssrc, initialPayloadType = 118 }) {
    this.socket = socket;
    this.getRemote = getRemote;
    this.ssrc = ssrc;
    this.payloadType = initialPayloadType; // Asterisk's slin16 PT is usually 118; auto-updated on first inbound
    this.queue = Buffer.alloc(0);
    this.seq = Math.floor(Math.random() * 0xffff);
    this.ts = 0;
    this.timer = null;
    this.packetsSent = 0;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), FRAME_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  push(pcm) {
    if (!Buffer.isBuffer(pcm) || pcm.length === 0) return;
    this.queue = Buffer.concat([this.queue, pcm]);
  }

  _tick() {
    if (this.queue.length < BYTES_PER_FRAME) return;
    const remote = this.getRemote();
    if (!remote) return;

    const payload = this.queue.subarray(0, BYTES_PER_FRAME);
    this.queue = this.queue.subarray(BYTES_PER_FRAME);

    const packet = buildRtpPacket({
      payloadType: this.payloadType,
      sequenceNumber: this.seq,
      timestamp: this.ts,
      ssrc: this.ssrc,
      payload,
    });
    this.seq = (this.seq + 1) & 0xffff;
    this.ts = (this.ts + SAMPLES_PER_FRAME) >>> 0;

    this.socket.send(packet, remote.port, remote.address, (err) => {
      if (err) log(`pacer send error: ${err.message}`);
      else this.packetsSent++;
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Shared setup used by both echo and ai modes.
// Returns the state object with UDP + ARI resources up but no message handlers.
// ─────────────────────────────────────────────────────────────────────────

async function setupCallPlumbing(ariClient, appName, callerChannel, meta, mode) {
  const port = allocatePort();
  const channelId = callerChannel.id;

  /** @type {BridgeState} */
  const state = {
    channelId,
    port,
    mode,
    socket: null,
    bridge: null,
    externalMedia: null,
    outboundSeq: Math.floor(Math.random() * 0xffff),
    outboundTs: 0,
    outboundSsrc: randomSsrc(),
    remoteRinfo: null,
    packetsIn: 0,
    packetsOut: 0,
    cleaned: false,
    session: null,
    pacer: null,
    hardTimer: null,
    toolCallCount: 0,
    toolRegistry: null,
    userId: null,
  };
  log(`[${channelId}] setupCallPlumbing state:`, state);
  activeBridges.set(channelId, state);

  // 1. Bind UDP socket.
  state.socket = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    const onErr = (e) => reject(e);
    state.socket.once('error', onErr);
    state.socket.bind(port, '0.0.0.0', () => {
      state.socket.removeListener('error', onErr);
      resolve();
    });
  });
  log(`[${channelId}] socket bound on 0.0.0.0:${port} (${mode})`);

  state.socket.on('error', (err) => {
    log(`[${channelId}] socket error: ${err.message}`);
  });

  // 2. Answer the caller.
  await callerChannel.answer();
  log(`[${channelId}] answered from=${meta.from} to=${meta.to}`);

  // 3. Create the mixing Bridge.
  state.bridge = ariClient.Bridge();
  await state.bridge.create({ type: 'mixing' });

  // 4. Create the ExternalMedia channel. Asterisk connects OUT to us
  //    (default connection_type=client), so we just need to be listening.
  state.externalMedia = await ariClient.channels.externalMedia({
    app: appName,
    external_host: `${HOSTNAME}:${port}`,
    format: 'slin16',
    encapsulation: 'rtp',
    transport: 'udp',
  });
  log(
    `[${channelId}] bridge=${state.bridge.id} externalMedia=${state.externalMedia.id} ` +
      `→ ${HOSTNAME}:${port} (slin16)`
  );

  // 5. Bridge both channels together — audio flows.
  await state.bridge.addChannel({
    channel: [channelId, state.externalMedia.id],
  });

  return state;
}

// ─────────────────────────────────────────────────────────────────────────
// startEchoCall — Phase 3 loopback test.
// ─────────────────────────────────────────────────────────────────────────

export async function startEchoCall(ariClient, appName, callerChannel, meta = {}) {
  let state;
  try {
    state = await setupCallPlumbing(ariClient, appName, callerChannel, meta, 'echo');

    state.socket.on('message', (msg, rinfo) => {
      let rtp;
      try {
        rtp = parseRtpPacket(msg);
      } catch (e) {
        log(`[${state.channelId}] RTP parse error: ${e.message}`);
        return;
      }
      state.packetsIn++;
      state.remoteRinfo = rinfo;

      if (state.packetsIn === 1) {
        log(
          `[${state.channelId}] first RTP from ${rinfo.address}:${rinfo.port} ` +
            `pt=${rtp.payloadType} payload=${rtp.payload.length}B`
        );
      }

      const echo = buildRtpPacket({
        payloadType: rtp.payloadType,
        sequenceNumber: state.outboundSeq,
        timestamp: state.outboundTs,
        ssrc: state.outboundSsrc,
        payload: rtp.payload,
      });
      state.outboundSeq = (state.outboundSeq + 1) & 0xffff;
      state.outboundTs = (state.outboundTs + SAMPLES_PER_FRAME) >>> 0;

      state.socket.send(echo, rinfo.port, rinfo.address, (err) => {
        if (err) log(`[${state.channelId}] send error: ${err.message}`);
        else state.packetsOut++;
      });
    });

    callerChannel.once('StasisEnd', () => {
      log(
        `[${state.channelId}] StasisEnd — packets in=${state.packetsIn} out=${state.packetsOut}`
      );
      cleanup(state).catch((e) => log(`cleanup error: ${e.message}`));
    });

    return state;
  } catch (err) {
    log(`[${callerChannel.id}] echo setup FAILED: ${err.message}`);
    if (state) await cleanup(state);
    try {
      await callerChannel.hangup();
    } catch {
      // Channel may already be gone — ignore.
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// startAiCall — Phase 4 full conversation.
// ─────────────────────────────────────────────────────────────────────────

export async function startAiCall(ariClient, appName, callerChannel, meta = {}) {
  const channelId = callerChannel.id;
  const callerNumber = callerChannel.caller?.number || '';
  const userId = callerNumber || `anon_${channelId}`;

  log(`[${channelId}] starting AI — caller=${callerNumber || '(anon)'} userId=${userId} ariClient=${ariClient} appName=${appName} callerChannel=${callerChannel} meta=${meta} channelId=${channelId} callerNumber=${callerNumber} userId=${userId}`);

  let state;
  try {
    log(`[${channelId}] starting setupCallPlumbing`);
    state = await setupCallPlumbing(ariClient, appName, callerChannel, meta, 'ai');
    log(`[${channelId}] setupCallPlumbing completed`);
    state.userId = userId;

    // Seed the conversation store with the userId BEFORE building context so
    // long-term memory (keyed by userId) is looked up correctly.
    getOrCreateSession(channelId, EGYPT_COUNTRY, userId);

    // Build tool definitions + registry (country=50 = Egypt).
    const { definitions, registry } = buildToolset(EGYPT_COUNTRY, channelId);
    state.toolRegistry = registry;

    // Compose Realtime instructions: base voice prompt + user memory + summary
    // + recent turns + phone-mode postscript.
    const context = await buildRealtimeContext(channelId);
    const instructions = `${context.instructions}\n\n${PHONE_MODE_POSTSCRIPT}`;

    // Open the OpenAI Realtime WebSocket.
    state.session = await createRealtimeSession();
    log(`[${channelId}] Realtime WS connected`);

    // Configure the session for a full duplex phone conversation.
    // Both audio formats set to PCM16 @ 16 kHz to match slin16 byte-for-byte —
    // no resampling on either direction of the audio path.
    state.session.sessionUpdate({
      type: 'realtime',
      output_modalities: ['audio'],
      instructions,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: SAMPLE_RATE_HZ },
          turn_detection: SERVER_VAD,
          transcription: {
            model: TRANSCRIBE_MODEL,
            ...(TRANSCRIBE_LANGUAGE ? { language: TRANSCRIBE_LANGUAGE } : {}),
          },
          noise_reduction: { type: 'far_field' },
        },
        output: {
          format: { type: 'audio/pcm', rate: SAMPLE_RATE_HZ },
          voice: REALTIME_VOICE,
          speed: REALTIME_SPEED,
        },
      },
      tools: definitions,
      tool_choice: 'auto',
    });

    // Outbound pacer: OpenAI audio → 20 ms RTP frames → Asterisk.
    state.pacer = new OutboundRtpPacer({
      socket: state.socket,
      getRemote: () => state.remoteRinfo,
      ssrc: state.outboundSsrc,
    });
    state.pacer.start();

    // Inbound RTP → OpenAI input_audio_buffer.
    state.socket.on('message', (msg, rinfo) => {
      let rtp;
      try {
        rtp = parseRtpPacket(msg);
      } catch (e) {
        log(`[${channelId}] RTP parse error: ${e.message}`);
        return;
      }
      state.packetsIn++;
      state.remoteRinfo = rinfo;

      // Match outbound PT to what Asterisk uses for this call.
      if (state.packetsIn === 1) {
        state.pacer.payloadType = rtp.payloadType;
        log(
          `[${channelId}] first RTP from ${rinfo.address}:${rinfo.port} ` +
            `pt=${rtp.payloadType} payload=${rtp.payload.length}B`
        );
      }

      try {
        state.session.appendAudio(rtp.payload);
      } catch (e) {
        log(`[${channelId}] appendAudio failed: ${e.message}`);
      }
    });

    // OpenAI audio → outbound pacer.
    state.session.on('audio', (pcm) => {
      state.pacer.push(pcm);
    });

    // Function calls — dispatch to Byit tools via the shared registry.
    state.session.on('function_call', async ({ callId, name, arguments: rawArgs }) => {
      state.toolCallCount++;
      log(
        `[${channelId}] function_call #${state.toolCallCount} name=${name} callId=${callId}`
      );

      if (state.toolCallCount > MAX_TOOL_CALLS) {
        log(`[${channelId}] tool call limit reached (${MAX_TOOL_CALLS}) — refusing`);
        try {
          state.session.sendFunctionCallOutput(
            callId,
            JSON.stringify({
              error: 'tool_limit_reached',
              limit: MAX_TOOL_CALLS,
              message: 'This conversation has reached its tool-call limit.',
            })
          );
          state.session.createResponse();
        } catch (e) {
          log(`[${channelId}] refuse-tool send failed: ${e.message}`);
        }
        return;
      }

      const parsed = {
        callId,
        name,
        arguments: safeJsonParse(rawArgs, {}),
      };
      try {
        const result = await handleToolCall(parsed, state.toolRegistry);
        state.session.sendFunctionCallOutput(callId, result.output);
        state.session.createResponse();
      } catch (e) {
        log(`[${channelId}] tool ${name} dispatch failed: ${e.message}`);
        try {
          state.session.sendFunctionCallOutput(
            callId,
            JSON.stringify({ error: 'tool_dispatch_failed', detail: String(e.message || e) })
          );
          state.session.createResponse();
        } catch {
          // WS may be down — cleanup will fire.
        }
      }
    });

    // Feed transcripts into the memory / context layer.
    state.session.on('user_transcript', (text) => {
      log(`[${channelId}] user: "${(text || '').slice(0, 80)}"`);
      try {
        addMessage(channelId, { role: 'user', text });
      } catch {
        // Session may not exist if cleanup already ran — ignore.
      }
      recordUserTurn(channelId, text).catch((e) =>
        log(`[${channelId}] recordUserTurn failed: ${e.message}`)
      );
    });
    state.session.on('transcript.done', (text) => {
      log(`[${channelId}] asst: "${(text || '').slice(0, 80)}"`);
      try {
        addMessage(channelId, { role: 'assistant', text });
      } catch {
        // Ignore.
      }
      try {
        recordAssistantTurn(channelId, text);
      } catch {
        // Ignore.
      }
    });

    // Session lifecycle.
    state.session.on('error', (err) => {
      log(`[${channelId}] Realtime error: ${err.message}`);
      cleanup(state).catch(() => {});
      callerChannel.hangup().catch(() => {});
    });
    state.session.on('close', ({ code, reason }) => {
      log(`[${channelId}] Realtime closed: ${code} ${reason || ''}`);
      cleanup(state).catch(() => {});
      callerChannel.hangup().catch(() => {});
    });

    // Max call duration guard — hangs up the caller if the conversation runs long.
    state.hardTimer = setTimeout(() => {
      log(`[${channelId}] max call duration ${MAX_CALL_SECONDS}s reached — hanging up`);
      callerChannel.hangup().catch(() => {});
    }, MAX_CALL_SECONDS * 1000);

    // Cleanup on caller hangup.
    callerChannel.once('StasisEnd', () => {
      log(
        `[${channelId}] StasisEnd — packets in=${state.packetsIn} ` +
          `outSent=${state.pacer?.packetsSent ?? 0} tools=${state.toolCallCount}`
      );
      cleanup(state).catch((e) => log(`cleanup error: ${e.message}`));
    });

    // Kick off the conversation with a short greeting so the caller isn't
    // met with dead air.
    state.session.createResponse({ instructions: DEFAULT_GREETING_INSTRUCTION });

    return state;
  } catch (err) {
    log(`[${channelId}] AI setup FAILED: ${err.message}`);
    if (state) await cleanup(state);
    try {
      await callerChannel.hangup();
    } catch {
      // Channel may already be gone — ignore.
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Unified cleanup: handles both echo and ai state shapes.
// ─────────────────────────────────────────────────────────────────────────

async function cleanup(state) {
  if (state.cleaned) return;
  state.cleaned = true;
  activeBridges.delete(state.channelId);

  // AI-mode extras — no-ops when unset.
  if (state.pacer) {
    try {
      state.pacer.stop();
    } catch {
      // Ignore.
    }
    state.pacer = null;
  }
  if (state.hardTimer) {
    clearTimeout(state.hardTimer);
    state.hardTimer = null;
  }
  if (state.session) {
    try {
      state.session.close();
    } catch {
      // Ignore.
    }
    state.session = null;
  }

  // Shared plumbing.
  if (state.socket) {
    try {
      state.socket.close();
    } catch {
      // Ignore.
    }
    state.socket = null;
  }
  if (state.externalMedia) {
    try {
      await state.externalMedia.hangup();
    } catch {
      // Channel already gone — ignore.
    }
    state.externalMedia = null;
  }
  if (state.bridge) {
    try {
      await state.bridge.destroy();
    } catch {
      // Bridge already destroyed — ignore.
    }
    state.bridge = null;
  }

  releasePort(state.port);

  if (state.mode === 'ai') {
    try {
      clearRawForSession(state.channelId);
    } catch {
      // Ignore.
    }
  }

  log(`[${state.channelId}] cleaned up (${state.mode}) — port ${state.port} released`);
}

/** For /health and diagnostics. */
export function getStatus() {
  const usedPorts = PORT_MAX - PORT_MIN + 1 - availablePorts.size;
  return {
    active: activeBridges.size,
    portsUsed: usedPorts,
    portsFree: availablePorts.size,
    portRange: [PORT_MIN, PORT_MAX],
    hostname: HOSTNAME,
    limits: {
      maxCallSeconds: MAX_CALL_SECONDS,
      maxToolCallsPerCall: MAX_TOOL_CALLS,
    },
  };
}
