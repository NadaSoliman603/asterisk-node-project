'use strict';

require('dotenv').config();

const http = require('http');
const ari = require('./ari');
const ami = require('./ami');

const config = {
  ari: {
    url: process.env.ARI_URL || 'http://asterisk:8088',
    user: process.env.ARI_USER || 'ariuser',
    password: process.env.ARI_PASSWORD || 'changeme-ari',
    appName: process.env.ARI_APP_NAME || 'node-stasis-app',
  },
  ami: {
    host: process.env.AMI_HOST || 'asterisk',
    port: parseInt(process.env.AMI_PORT || '5038', 10),
    user: process.env.AMI_USER || 'amiuser',
    password: process.env.AMI_PASSWORD || 'changeme-ami',
  },
  http: {
    port: parseInt(process.env.PORT || '3000', 10),
  },
  sipExtension: process.env.SIP_EXTENSION || '1000',
  twilio: {
    did: process.env.TWILIO_DID || '',
    // Trial-account guardrail. Only these E.164 destinations may be
    // originated via /place-call. Set TWILIO_VERIFIED_NUMBERS to a
    // comma-separated list. Defaults to the verified test number.
    verified: (process.env.TWILIO_VERIFIED_NUMBERS || '+201069035556')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

const DEFAULT_TEST_TO = config.twilio.verified[0] || null;

function jsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ _parseError: true });
      }
    });
  });
}

function isVerified(number) {
  return config.twilio.verified.includes(number);
}

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    // ---- health --------------------------------------------------------
    if (req.method === 'GET' && req.url === '/health') {
      const body = {
        status: ari.isConnected() && ami.isConnected() ? 'ok' : 'degraded',
        ari: { connected: ari.isConnected(), app: ari.getAppName() },
        ami: { connected: ami.isConnected() },
        twilio: {
          did: config.twilio.did || null,
          verifiedCount: config.twilio.verified.length,
        },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
      return;
    }

    // ---- /test-call (local softphone loop-back) ------------------------
    // Rings extension 1000 → on answer → dialplan exten 200 → Stasis.
    // Kept for local testing; does NOT go out through Twilio.
    if (req.method === 'POST' && req.url === '/test-call') {
      try {
        const result = await ami.originateTestCall({ extension: config.sipExtension });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }, null, 2));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message, ...err }, null, 2));
      }
      return;
    }

    // ---- /place-call (real outbound via Twilio) ------------------------
    // POST body: { "to": "+201069035556" }   (defaults to first verified num)
    if (req.method === 'POST' && req.url === '/place-call') {
      const body = await jsonBody(req);
      if (body._parseError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
        return;
      }
      const to = body.to || DEFAULT_TEST_TO;
      if (!to) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: 'no target number: pass {"to":"+E164"} or set TWILIO_VERIFIED_NUMBERS',
          })
        );
        return;
      }
      // Trial-account guardrail — refuse anything not on the allowlist.
      if (!isVerified(to)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            {
              ok: false,
              error: `refusing to originate to ${to} — not in TWILIO_VERIFIED_NUMBERS`,
              hint: 'Twilio trial accounts only permit calls to verified numbers.',
              allowlist: config.twilio.verified,
            },
            null,
            2
          )
        );
        return;
      }

      try {
        const result = await ami.placeCall({
          toNumber: to,
          fromTrunk: 'twilio-trunk',
          callerId: config.twilio.did ? `<${config.twilio.did}>` : undefined,
          stasisApp: config.ari.appName,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }, null, 2));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        // err carries reason/channel/uniqueid from ami.js when Originate fails
        const payload = {
          ok: false,
          error: err.message,
          reason: err.reason,
          channel: err.channel,
          uniqueid: err.uniqueid,
        };
        res.end(JSON.stringify(payload, null, 2));
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(config.http.port, () => {
    console.log(`[HTTP] listening on ${config.http.port}`);
  });

  return server;
}

async function main() {
  console.log('[BOOT] starting node-app');
  if (config.twilio.verified.length === 0) {
    console.warn('[BOOT] TWILIO_VERIFIED_NUMBERS is empty — /place-call will refuse all targets');
  }
  startHttpServer();

  const results = await Promise.allSettled([
    ari.start(config.ari),
    ami.start(config.ami),
  ]);

  results.forEach((r, i) => {
    const name = i === 0 ? 'ARI' : 'AMI';
    if (r.status === 'rejected') {
      console.error(`[BOOT] ${name} failed to connect after retries:`, r.reason && r.reason.message);
    } else {
      console.log(`[BOOT] ${name} ready`);
    }
  });
}

function shutdown(signal) {
  console.log(`[SHUTDOWN] ${signal} received, exiting`);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
