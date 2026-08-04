'use strict';

const ariClient = require('ari-client');

// Configurable greeting played to inbound Twilio callers.
// Format: `<basename>` — no `sound:` prefix, no file extension.
// Files resolve from /var/lib/asterisk/sounds/<name>.<ext> inside the
// container. The compose stack bind-mounts ./sounds/custom → …/sounds/custom.
const INBOUND_GREETING = process.env.INBOUND_GREETING_SOUND || 'custom/greeting';

const state = {
  connected: false,
  client: null,
  appName: null,
};

function log(...args) {
  console.log('[ARI]', ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry({ url, user, password, appName }) {
  const maxAttempts = 30;
  let attempt = 0;
  let delay = 1000;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      log(`connect attempt ${attempt} → ${url} as ${user}`);
      const client = await ariClient.connect(url, user, password);
      log('connected');
      return client;
    } catch (err) {
      log(`connect failed: ${err.message}`);
      if (attempt >= maxAttempts) throw err;
      await sleep(delay);
      delay = Math.min(delay * 2, 15000);
    }
  }
  throw new Error('ARI: exhausted retries');
}

/**
 * Classify a StasisStart into one of: 'twilio-inbound', 'twilio-outbound',
 * 'local', or 'unknown'. Uses the dialplan args we set in extensions.conf
 * (first arg = 'from-twilio' | 'outbound') and falls back to the channel's
 * dialplan context / endpoint tech for defense-in-depth.
 */
function classifyCall(event, channel) {
  const args = event.args || [];
  if (args[0] === 'from-twilio') return 'twilio-inbound';
  if (args[0] === 'outbound') return 'twilio-outbound';

  const ctx = channel.dialplan && channel.dialplan.context;
  if (ctx === 'from-twilio') return 'twilio-inbound';
  if (ctx === 'to-twilio') return 'twilio-outbound';
  if (ctx === 'from-internal') return 'local';

  // Endpoint tech fallback (e.g. PJSIP/1000-... vs PJSIP/+123@twilio-trunk-...)
  if (channel.name && channel.name.includes('@twilio-trunk')) return 'twilio-outbound';
  return 'unknown';
}

function registerHandlers(client, appName) {
  client.on('StasisStart', (event, channel) => {
    const kind = classifyCall(event, channel);
    const from = channel.caller && channel.caller.number;
    const to = (event.args && event.args[1]) || (channel.dialplan && channel.dialplan.exten);

    log(
      `StasisStart [${kind}] channel=${channel.name} id=${channel.id} ` +
        `from=${from} to=${to} args=${JSON.stringify(event.args || [])}`
    );

    // Route by call kind. Kept as explicit branches per the spec — do NOT
    // collapse into a single generic handler.
    if (kind === 'twilio-inbound') {
      handleInboundTwilio(channel, { from, to }).catch((e) =>
        log('twilio-inbound handler error:', e.message)
      );
      return;
    }
    if (kind === 'twilio-outbound') {
      handleOutboundTwilio(channel, { from, to }).catch((e) =>
        log('twilio-outbound handler error:', e.message)
      );
      return;
    }
    handleLocal(channel).catch((e) => log('local handler error:', e.message));
  });

  async function safeHangup(channel, reason) {
    try {
      await channel.hangup();
      log(`[twilio-inbound] hung up channel=${channel.name} reason=${reason}`);
    } catch (err) {
      // Channel may already be gone (caller hung up first) — that's fine.
      log(`[twilio-inbound] hangup error (${reason}):`, err.message);
    }
  }

  async function handleInboundTwilio(channel, meta) {
    // Inbound Twilio call → answer, play greeting, wait for PlaybackFinished,
    // then hang up. Each step is guarded so a failure at one stage still
    // leaves the channel in a defined state (hung up, not orphaned).
    log(`[twilio-inbound] answering call from ${meta.from} → DID ${meta.to}`);

    // 1. Answer
    try {
      await channel.answer();
    } catch (err) {
      log(`[twilio-inbound] answer error:`, err.message);
      await safeHangup(channel, 'answer-failed');
      return;
    }
    log(`[twilio-inbound] answered channel=${channel.name}`);

    // 2. Start playback
    const media = `sound:${INBOUND_GREETING}`;
    let playback;
    try {
      playback = await channel.play({ media });
    } catch (err) {
      log(`[twilio-inbound] play(${media}) error:`, err.message);
      await safeHangup(channel, 'play-failed');
      return;
    }
    log(`[twilio-inbound] playback started id=${playback.id} media=${media}`);

    // 3. Wait for PlaybackFinished (do NOT use setTimeout — length varies).
    //    Also handle PlaybackFailed and the caller hanging up mid-playback.
    const cleanup = () => {
      playback.removeAllListeners('PlaybackFinished');
      playback.removeAllListeners('PlaybackFailed');
      channel.removeAllListeners('StasisEnd');
    };

    playback.once('PlaybackFinished', async () => {
      cleanup();
      log(`[twilio-inbound] playback finished id=${playback.id} — hanging up`);
      await safeHangup(channel, 'playback-finished');
    });

    playback.once('PlaybackFailed', async (evt) => {
      cleanup();
      log(`[twilio-inbound] playback FAILED id=${playback.id} evt=${JSON.stringify(evt && evt.playback)}`);
      await safeHangup(channel, 'playback-failed');
    });

    // If the caller drops during playback, StasisEnd fires — no hangup needed
    // (channel is already gone) but we should stop listening for playback events.
    channel.once('StasisEnd', () => {
      cleanup();
      log(`[twilio-inbound] caller hung up during playback id=${playback.id}`);
    });
  }

  async function handleOutboundTwilio(channel, meta) {
    // Our own Originate answered by the PSTN callee. The channel is already
    // "up" from the callee's perspective; play a short prompt to prove audio
    // path, then hang up. Real app would bridge this to another channel,
    // stream TTS, etc.
    log(`[twilio-outbound] callee answered: ${meta.to || channel.name}`);
    const playback = await channel.play({ media: 'sound:hello-world' });
    playback.once('PlaybackFinished', () => {
      channel.hangup().catch((e) => log('hangup error:', e.message));
    });
  }

  async function handleLocal(channel) {
    // Original local-extension behavior — unchanged for the [1000] test path.
    await channel.answer();
    const playback = await channel.play({ media: 'sound:hello-world' });
    playback.once('PlaybackFinished', () => {
      channel.hangup().catch((e) => log('hangup error:', e.message));
    });
  }

  client.on('StasisEnd', (event, channel) => {
    log(`StasisEnd channel=${channel.name}`);
  });

  client.on('APILoadError', (err) => {
    log('API load error:', err.message);
  });

  client.on('WebSocketReconnecting', () => {
    state.connected = false;
    log('websocket reconnecting');
  });

  client.on('WebSocketConnected', () => {
    state.connected = true;
    log('websocket connected');
  });

  client.on('WebSocketMaxRetries', () => {
    state.connected = false;
    log('websocket gave up reconnecting');
  });
}

async function start(config) {
  const client = await connectWithRetry(config);
  state.client = client;
  state.appName = config.appName;

  registerHandlers(client, config.appName);

  await client.start(config.appName);
  state.connected = true;
  log(`Stasis app "${config.appName}" registered`);

  return client;
}

function isConnected() {
  return state.connected;
}

function getAppName() {
  return state.appName;
}

module.exports = { start, isConnected, getAppName };
