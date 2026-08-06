/**
 * Server-side OpenAI Realtime WebSocket client.
 *
 * The browser voice app (expo-chatbot-api) uses WebRTC directly from the
 * browser; a phone call has no browser, so the Node process itself must be
 * the OpenAI client. This module is that client — a thin EventEmitter around
 * `wss://api.openai.com/v1/realtime` that:
 *
 *   1. Opens one WebSocket per call/session.
 *   2. Sends session config (instructions, voice, audio formats, tools) via
 *      `session.update`.
 *   3. Fans out incoming events into typed listener events so callers don't
 *      have to switch on `evt.type` themselves.
 *
 * Audio-format decisions (WS transport, not WebRTC — codec is NOT SDP-negotiated):
 *   - Input:  raw PCM16 mono, little-endian, 16 kHz — matches Asterisk's
 *             slin16 external-media output byte-for-byte (Phase 3 wiring).
 *   - Output: raw PCM16 mono, little-endian, 24 kHz — OpenAI Realtime's
 *             default speech sample rate; downsampled to 16 kHz before RTP
 *             hand-off in Phase 3.
 *
 * This module intentionally knows nothing about Asterisk, RTP, or the Byit
 * memory layer — Phase 3 (`aiVoiceBridge.js`) wires those together.
 */

import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { OPENAI_REALTIME_API_KEY, OPENAI_REALTIME_MODEL } from './constants/index.js';

const WS_BASE = process.env.OPENAI_REALTIME_WS_URL || 'wss://api.openai.com/v1/realtime';

// PCM sample rates we tell OpenAI to use. Kept as constants so the WAV writer
// (which needs the rate in its header) can't drift from the session config.
export const INPUT_SAMPLE_RATE_HZ = 16000;
export const OUTPUT_SAMPLE_RATE_HZ = 24000;

/**
 * A single Realtime WebSocket session. One instance per active call.
 *
 * Emitted events:
 *   'open'                — WS handshake completed
 *   'event',  evt         — every raw JSON event (for debugging / tracing)
 *   'audio',  Buffer      — decoded PCM16 chunk from response.output_audio.delta
 *   'transcript.delta', s — streaming assistant transcript
 *   'transcript.done',  s — final assistant transcript for this turn
 *   'user_transcript',  s — final user transcript (from input STT)
 *   'function_call', {callId, name, arguments}  — model wants a tool run
 *   'response.done',  response — turn finalized
 *   'error',   Error     — WS or server error
 *   'close',   {code, reason}
 */
export class OpenAIRealtimeSession extends EventEmitter {
  constructor({
    apiKey = OPENAI_REALTIME_API_KEY,
    model = OPENAI_REALTIME_MODEL,
    wsUrl = WS_BASE,
  } = {}) {
    super();
    if (!apiKey) {
      throw new Error(
        'OPENAI_REALTIME_API_KEY is required (set it in .env or pass {apiKey})'
      );
    }
    this.apiKey = apiKey;
    this.model = model;
    this.wsUrl = wsUrl;
    this.ws = null;
    this.ready = false;
  }

  /** Open the WebSocket and resolve when the handshake completes. */
  connect() {
    const url = `${this.wsUrl}?model=${encodeURIComponent(this.model)}`;
    return new Promise((resolve, reject) => {
      // GA Realtime API: authenticate with the bearer token only. The old
      // `OpenAI-Beta: realtime=v1` header now triggers "The Realtime Beta API
      // is no longer supported. Please use /v1/realtime for the GA API."
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      const onOpen = () => {
        this.ready = true;
        this.ws.removeListener('error', onErrBeforeOpen);
        this.emit('open');
        resolve();
      };
      const onErrBeforeOpen = (err) => {
        this.ws.removeListener('open', onOpen);
        reject(err);
      };

      this.ws.once('open', onOpen);
      this.ws.once('error', onErrBeforeOpen);

      this.ws.on('message', (data) => this.#onMessage(data));
      this.ws.on('error', (err) => {
        if (this.ready) this.emit('error', err);
      });
      this.ws.on('close', (code, reason) => {
        this.ready = false;
        this.emit('close', { code, reason: reason?.toString() || '' });
      });
    });
  }

  /** Route one raw event into typed listener events. */
  #onMessage(data) {
    let evt;
    try {
      evt = JSON.parse(data.toString('utf8'));
    } catch (e) {
      this.emit('error', new Error(`unparseable event: ${e.message}`));
      return;
    }
    this.emit('event', evt);

    switch (evt.type) {
      // Audio deltas — the GA event name is `response.output_audio.delta`;
      // some earlier documentation used `response.audio.delta`. Handle both.
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        if (evt.delta) this.emit('audio', Buffer.from(evt.delta, 'base64'));
        break;
      }
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        if (evt.delta) this.emit('transcript.delta', evt.delta);
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (evt.transcript) this.emit('transcript.done', evt.transcript);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (evt.transcript) this.emit('user_transcript', evt.transcript);
        break;
      case 'response.function_call_arguments.done':
        this.emit('function_call', {
          callId: evt.call_id,
          name: evt.name,
          arguments: evt.arguments,
        });
        break;
      case 'response.done':
        this.emit('response.done', evt.response);
        break;
      case 'error':
        this.emit(
          'error',
          new Error(evt.error?.message || `realtime error: ${JSON.stringify(evt.error)}`)
        );
        break;
      // Every other event (session.created, rate_limits.updated, etc.) is
      // available on the generic 'event' listener above.
    }
  }

  /** Low-level send. Throws before the WS is open. */
  send(msg) {
    if (!this.ready) throw new Error('OpenAIRealtimeSession: not connected');
    this.ws.send(JSON.stringify(msg));
  }

  /** Update session config (instructions, voice, tools, audio formats). */
  sessionUpdate(session) {
    this.send({ type: 'session.update', session });
  }

  /** Insert a user text turn (for text-in flows and /debug/tts). */
  addUserText(text) {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
  }

  /** Append PCM16 mono audio to the input buffer (Phase 3: RTP → here). */
  appendAudio(pcm16Buffer) {
    this.send({
      type: 'input_audio_buffer.append',
      audio: pcm16Buffer.toString('base64'),
    });
  }

  commitAudio() {
    this.send({ type: 'input_audio_buffer.commit' });
  }

  clearAudio() {
    this.send({ type: 'input_audio_buffer.clear' });
  }

  /**
   * Ask the model for a response.
   * @param {object} [options]  merged into the `response` field
   *   e.g. { modalities: ['audio'], instructions: 'read this aloud: ...' }
   */
  createResponse(options = {}) {
    this.send({ type: 'response.create', response: options });
  }

  /** Return a tool result to the model. */
  sendFunctionCallOutput(callId, output) {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output,
      },
    });
  }

  close() {
    this.ready = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
    this.ws = null;
  }
}

/** Convenience: connect + return a ready session. */
export async function createRealtimeSession(opts) {
  const s = new OpenAIRealtimeSession(opts);
  await s.connect();
  return s;
}

// ─── WAV writer ────────────────────────────────────────────────────────────
// Minimal, dependency-free PCM16 → WAV wrapper. Used by the /debug/tts route
// to turn a collected audio stream into a downloadable file. Phase 3 does not
// use this — RTP is a raw stream, no container.

/**
 * Wrap raw PCM16 mono samples in a WAV (RIFF) container.
 * @param {Buffer} pcm            little-endian 16-bit signed PCM
 * @param {number} sampleRateHz   e.g. 24000 or 16000
 * @returns {Buffer}              a valid .wav file
 */
export function pcm16ToWav(pcm, sampleRateHz) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRateHz * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4); // total file size - 8
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);           // fmt chunk size
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

// ─── /debug/tts helper ────────────────────────────────────────────────────
// End-to-end proof that our WS wiring works: text goes in, spoken audio comes
// out. Not used on the call path — call flow is Phase 3 (Asterisk audio →
// input_audio_buffer.append) — but this smoke-tests everything upstream of
// that: WS connect, session config, PCM decode, response.done handling.

const DEFAULT_TTS_TIMEOUT_MS = 30_000;

/**
 * Speak `text` through OpenAI Realtime and collect the PCM audio.
 * Returns { wav, transcript, sampleRate } — no side effects.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.voice='alloy']
 * @param {number} [opts.timeoutMs=30000]
 * @returns {Promise<{ wav: Buffer, transcript: string, sampleRate: number }>}
 */
export async function textToSpeech(text, opts = {}) {
  const { voice = process.env.REALTIME_VOICE || 'alloy', timeoutMs = DEFAULT_TTS_TIMEOUT_MS } = opts;
  if (!text || typeof text !== 'string') throw new Error('text is required');

  const session = await createRealtimeSession();

  const chunks = [];
  let transcript = '';
  let settled = false;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`textToSpeech timeout after ${timeoutMs}ms`)), timeoutMs);

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.close();
      if (err) return reject(err);
      resolve({
        wav: pcm16ToWav(Buffer.concat(chunks), OUTPUT_SAMPLE_RATE_HZ),
        transcript,
        sampleRate: OUTPUT_SAMPLE_RATE_HZ,
      });
    };

    session.on('audio', (buf) => chunks.push(buf));
    session.on('transcript.delta', (d) => (transcript += d));
    session.on('transcript.done', (t) => (transcript = t));
    session.on('error', (err) => finish(err));
    session.on('close', () => {
      if (!settled) finish(new Error('WebSocket closed before response.done'));
    });
    session.on('response.done', () => finish(null));

    try {
      // Configure this session for one-shot text→audio. No tools, no turn
      // detection — we drive the response manually with createResponse().
      session.sessionUpdate({
        type: 'realtime',
        output_modalities: ['audio'],
        audio: {
          input: { turn_detection: null },
          output: {
            voice,
            format: { type: 'audio/pcm', rate: OUTPUT_SAMPLE_RATE_HZ },
          },
        },
        instructions:
          'You are a text-to-speech engine used for pipeline testing. ' +
          'Speak the user\'s message aloud verbatim in a neutral voice, ' +
          'without adding any commentary, framing, or extra words.',
      });
      session.addUserText(text);
      session.createResponse({ modalities: ['audio'] });
    } catch (e) {
      finish(e);
    }
  });
}
