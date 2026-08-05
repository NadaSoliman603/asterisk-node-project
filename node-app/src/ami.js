import crypto from 'node:crypto';
import AsteriskManager from 'asterisk-manager';

const state = {
  connected: false,
  manager: null,
  // Map of ActionID → { resolve, reject, timer } for in-flight Originates.
  pendingOriginates: new Map(),
};

function log(...args) {
  console.log('[AMI]', ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


async function connectWithRetry({ host, port, user, password }) {
  const maxAttempts = 30;
  let attempt = 0;
  let delay = 1000;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      log(`connect attempt ${attempt} → ${host}:${port} as ${user}`);
      const manager = new AsteriskManager(port, host, user, password, true);
      manager.keepConnected();

      await new Promise((resolve, reject) => {
        const onReady = () => {
          manager.removeListener('error', onError);
          resolve();
        };
        const onError = (err) => {
          manager.removeListener('fullybooted', onReady);
          reject(err);
        };
        manager.once('fullybooted', onReady);
        manager.once('error', onError);
      });

      log('connected (fully booted)');
      return manager;
    } catch (err) {
      log(`connect failed: ${err.message || err}`);
      if (attempt >= maxAttempts) throw err;
      await sleep(delay);
      delay = Math.min(delay * 2, 15000);
    }
  }
  throw new Error('AMI: exhausted retries');
}

function registerHandlers(manager) {
  manager.on('managerevent', (evt) => {
    // Terse log: event name + common fields.
    const summary = [
      evt.event,
      evt.channel && `chan=${evt.channel}`,
      evt.calleridnum && `cid=${evt.calleridnum}`,
      evt.state && `state=${evt.state}`,
    ]
      .filter(Boolean)
      .join(' ');
    log('event:', summary);

    // Correlate real Originate outcomes back to placeCall() callers.
    // With Async=true the callback fires immediately with "Success" (queued);
    // the actual result arrives later as an OriginateResponse event carrying
    // the same ActionID we sent on the Originate action.
    if (evt.event === 'OriginateResponse' && evt.actionid) {
      const pending = state.pendingOriginates.get(evt.actionid);
      if (!pending) return;
      state.pendingOriginates.delete(evt.actionid);
      clearTimeout(pending.timer);

      const outcome = {
        response: evt.response,       // "Success" or "Failure"
        reason: evt.reason,           // numeric reason code
        channel: evt.channel,
        uniqueid: evt.uniqueid,
        calleridnum: evt.calleridnum,
      };
      if (evt.response === 'Success') pending.resolve(outcome);
      else pending.reject(Object.assign(new Error(`Originate failed (reason=${evt.reason})`), outcome));
    }
  });

  manager.on('connect', () => {
    state.connected = true;
    log('socket connected');
  });

  manager.on('disconnect', () => {
    state.connected = false;
    log('socket disconnected');
  });

  manager.on('error', (err) => {
    log('error:', err && err.message ? err.message : err);
  });
}

export async function start(config) {
  const manager = await connectWithRetry(config);
  state.manager = manager;
  state.connected = true;
  registerHandlers(manager);
  return manager;
}

/**
 * Wait for the real OriginateResponse event (post-Async queue) that matches
 * our ActionID. Rejects if no response arrives within `timeoutMs`.
 */
function awaitOriginateResponse(actionId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingOriginates.delete(actionId);
      reject(new Error(`Originate timeout after ${timeoutMs}ms (actionId=${actionId})`));
    }, timeoutMs);
    state.pendingOriginates.set(actionId, { resolve, reject, timer });
  });
}

/**
 * Originate a test call from AMI to the local test extension.
 * Rings PJSIP/<extension> in from-internal and, on answer, sends the call
 * to dialplan exten 200 → Stasis. Kept for local softphone-loopback testing.
 */
export async function originateTestCall({ extension, context = 'from-internal', exten = '200' }) {
  if (!state.manager) throw new Error('AMI not connected');
  const actionId = crypto.randomUUID();
  const responsePromise = awaitOriginateResponse(actionId, 30_000);

  state.manager.action(
    {
      Action: 'Originate',
      ActionID: actionId,
      Channel: `PJSIP/${extension}`,
      Context: context,
      Exten: exten,
      Priority: 1,
      CallerID: `NodeApp <${exten}>`,
      Async: 'true',
    },
    (err) => {
      if (err) {
        state.pendingOriginates.delete(actionId);
        const p = state.pendingOriginates.get(actionId);
        if (p) clearTimeout(p.timer);
        // The awaiter is still there; reject it directly.
        // (Rare: this is the "even the queue push failed" path.)
      }
    }
  );

  return responsePromise;
}

/**
 * Place a real outbound call THROUGH the Twilio trunk endpoint.
 * Rings `toNumber` (E.164) via `PJSIP/<toNumber>@<trunkEndpoint>` and, on
 * answer, hands the call to the Stasis app so Node can drive it via ARI.
 *
 * Waits for the actual OriginateResponse event (not the async queue ack),
 * so callers see real success/failure, not "queued".
 *
 * Trial-account safety: the caller (index.js) is responsible for
 * verified-number allowlist enforcement — this function does not
 * second-guess the target. Keep the guardrail at the API layer.
 */
export async function placeCall({
  toNumber,
  fromTrunk = 'twilio-trunk',
  callerId = null,
  stasisApp,
  timeoutMs = 45_000,
}) {
  if (!state.manager) throw new Error('AMI not connected');
  if (!toNumber) throw new Error('placeCall: toNumber is required');
  if (!stasisApp) throw new Error('placeCall: stasisApp is required');

  const actionId = crypto.randomUUID();
  const responsePromise = awaitOriginateResponse(actionId, timeoutMs);

  const params = {
    Action: 'Originate',
    ActionID: actionId,
    Channel: `PJSIP/${toNumber}@${fromTrunk}`,
    Application: 'Stasis',
    Data: `${stasisApp},outbound,${toNumber}`,
    // Async so we can accept multiple concurrent placeCall()s without
    // blocking the AMI socket on Twilio's ring time.
    Async: 'true',
    Timeout: String(Math.max(5_000, timeoutMs - 5_000)), // ring timeout, ms
  };
  if (callerId) params.CallerID = callerId;

  log(`placeCall → ${toNumber} via ${fromTrunk} (actionId=${actionId})`);
  state.manager.action(params, (err) => {
    if (err) log(`placeCall queue error: ${err.message || err}`);
  });

  return responsePromise;
}

export function isConnected() {
  return state.connected;
}
