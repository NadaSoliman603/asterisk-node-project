# Asterisk + Node.js Call Center Platform — Technical Documentation

A production-oriented reference for the Asterisk PBX + Node.js (ARI/AMI) integration
that powers this call-center stack. The service exposes an HTTP API for placing and
receiving PSTN calls through a Twilio Elastic SIP Trunk, and drives call flow via
Asterisk's REST Interface (ARI) and Asterisk Manager Interface (AMI).

---

## Table of Contents

1. [Overview](#1-overview)
2. [System Architecture](#2-system-architecture)
3. [Repository Layout](#3-repository-layout)
4. [Runtime Components](#4-runtime-components)
5. [Configuration Reference](#5-configuration-reference)
6. [HTTP API Reference](#6-http-api-reference)
7. [Call Flows](#7-call-flows)
8. [Deployment](#8-deployment)
9. [Operations & Observability](#9-operations--observability)
10. [Security Model](#10-security-model)
11. [Troubleshooting](#11-troubleshooting)
12. [Extension Guide](#12-extension-guide)

---

## 1. Overview

### 1.1 Purpose

This project is a reproducible, container-native call-control platform that pairs
**Asterisk** (open-source PBX) with a **Node.js** application. Together they:

- Register local SIP softphones (extension `1000`) for internal test calls.
- Receive inbound PSTN calls delivered through a **Twilio Elastic SIP Trunk**.
- Place outbound PSTN calls through the same trunk on demand via an HTTP endpoint.
- Play greeting audio, drive call state (answer, playback, hangup), and expose
  hooks for future IVR, TTS, recording, or bridging logic.

### 1.2 Design Goals

| Goal                              | How it is achieved                                                        |
|-----------------------------------|---------------------------------------------------------------------------|
| Cross-platform local development  | Bridge networking so it runs on Docker Desktop (macOS/Windows) and Linux. |
| Reproducibility                   | Fully declarative: `docker-compose.yml`, bind-mounted configs, `.env`.    |
| Separation of concerns            | Asterisk = signaling/media; Node = business logic + orchestration.        |
| Modern Asterisk stack             | `chan_pjsip` only; `chan_sip` is explicitly disabled.                     |
| Real outbound feedback            | AMI Originate correlated to the actual `OriginateResponse`, not the ack.  |
| Trial-account safety              | Node enforces a `TWILIO_VERIFIED_NUMBERS` allowlist before originating.   |
| CI/CD ready                       | GitHub Actions workflow deploys to a VPS on push to `main`.               |

### 1.3 Technology Stack

- **Asterisk** (image: `andrius/asterisk:latest`) — PBX, SIP signaling, RTP media.
- **Node.js 20+** — orchestrator app running the Stasis handler and HTTP API.
- **Docker Compose** — service orchestration.
- **Twilio Elastic SIP Trunking** — PSTN termination and origination.
- **npm packages** — `ari-client`, `asterisk-manager`, `dotenv`.

---

## 2. System Architecture

### 2.1 High-Level Diagram

```
                                +----------------------------+
                                |     Twilio Elastic Trunk   |
                                |   (PSTN in / PSTN out)     |
                                +-------------+--------------+
                                              |
                                    SIP / RTP | (UDP or TCP)
                                              |
              +-----------------+   +---------v----------+   +-----------------+
              |  SIP Softphone  |   |     Asterisk PBX    |  |   HTTP Client   |
              |  (ext. 1000)    +--->  chan_pjsip / ARI   <--+  curl / service |
              +-----------------+   |     + AMI + Dialplan |  +-----------------+
                                    +----+------------+----+
                                         |            |
                                    ARI  |            |  AMI
                                   (WS)  |            |  (TCP 5038)
                                         |            |
                                    +----v------------v----+
                                    |    Node.js App       |
                                    |  HTTP: /health,      |
                                    |        /test-call,   |
                                    |        /place-call   |
                                    +----------------------+
```

### 2.2 Interfaces at a Glance

| Interface | Direction   | Protocol           | Purpose                                       |
|-----------|-------------|--------------------|-----------------------------------------------|
| SIP       | in / out    | UDP+TCP 5060       | Signaling with softphones and Twilio          |
| RTP       | in / out    | UDP 10000–10100    | Voice media                                   |
| ARI       | Node ↔ AST  | HTTP + WebSocket   | Event-driven call control (Stasis)            |
| AMI       | Node ↔ AST  | TCP 5038           | Legacy events, Originate action               |
| HTTP API  | client ↔ Node | TCP 3000         | Health, test call, outbound placement         |

### 2.3 Why Both ARI and AMI

- **ARI** is Asterisk's modern, event-driven REST interface. Once a channel enters
  the `Stasis()` application, the Node app takes full control: answer, playback,
  bridging, DTMF, hangup, etc. This is where all business logic lives.
- **AMI** remains the most reliable path to issue **Originate** actions. The
  ARI-native equivalent is possible but AMI's semantics (Async + `OriginateResponse`
  event) are well-understood and correlate cleanly to a caller's promise.

This dual approach lets the Node app initiate calls via AMI and control them via ARI.

---

## 3. Repository Layout

```
asterisk-node-project/
├── .env / .env.example          # Shared configuration (git-ignored .env)
├── .github/workflows/deploy.yml # CI/CD: SSH deploy to VPS on push to main
├── .gitignore
├── README.md                    # Quick-start & operational guide
├── docker-compose.yml           # Orchestration of asterisk + node-app services
│
├── asterisk-config/             # Bind-mounted into /etc/asterisk (read-only)
│   ├── asterisk.conf            # Core paths and runtime user
│   ├── modules.conf             # Autoload; blocks chan_sip
│   ├── logger.conf              # Log channels + verbosity
│   ├── rtp.conf                 # RTP port range
│   ├── http.conf                # Enables built-in HTTP server (ARI transport)
│   ├── ari.conf                 # ARI user/password
│   ├── manager.conf             # AMI user + ACL
│   ├── pjsip.conf               # Endpoint 1000 + Twilio trunk (endpoint/auth/aor/identify)
│   └── extensions.conf          # Dialplan: from-internal / from-twilio / to-twilio
│
├── node-app/
│   ├── Dockerfile               # node:20-alpine + npm install
│   ├── package.json             # ari-client, asterisk-manager, dotenv
│   ├── .env / .env.example      # Node-specific runtime env
│   └── src/
│       ├── index.js             # HTTP server, boot sequence, verified-number guard
│       ├── ari.js               # ARI client + StasisStart classifier + handlers
│       └── ami.js               # AMI client + originateTestCall + placeCall
│
├── sounds/
│   └── custom/                  # Bind-mounted into /var/lib/asterisk/sounds/custom
│       └── greeting.wav         # Default inbound greeting (placeholder tone)
│
└── scripts/
    └── convert-audio.sh         # ffmpeg helper: any audio → 8 kHz mono PCM WAV
```

---

## 4. Runtime Components

### 4.1 Asterisk Service

- **Image**: `andrius/asterisk:latest`
- **Container name**: `asterisk`
- **Networking**: bridge network `pbx-net`
- **Config**: read-only bind mount from `./asterisk-config`
- **Sound library**: bind mount from `./sounds/custom` → `/var/lib/asterisk/sounds/custom`
- **Logs**: persisted in the `asterisk-logs` named volume

**Exposed ports**

| Port          | Purpose                                          |
|---------------|--------------------------------------------------|
| 5060/udp      | SIP signaling (softphones, direct Twilio UDP)    |
| 5060/tcp      | SIP signaling (Twilio via ngrok TCP tunnel)      |
| 10000-10100/udp | RTP media                                      |
| 8088/tcp      | ARI (HTTP + WebSocket)                           |
| 5038/tcp      | AMI                                              |

**Healthcheck** — `curl http://localhost:8088/ari/asterisk/info`; a `200` or `401`
response both indicate the HTTP transport is live and passes the compose gate.

### 4.2 Node.js Service (`node-app`)

- **Base image**: `node:20-alpine`
- **Working dir**: `/app`
- **Entrypoint**: `node src/index.js`
- **Runtime env**: injected from the top-level `.env` via `docker-compose.yml`
- **Depends on**: `asterisk` (waits for `service_healthy`)
- **Exposed port**: `3000/tcp`

**Modules**

| File          | Responsibility                                                          |
|---------------|-------------------------------------------------------------------------|
| `src/index.js`| Boots ARI + AMI, starts the HTTP server, enforces verified-number policy |
| `src/ari.js`  | ARI client, WebSocket lifecycle, `StasisStart` classifier & handlers    |
| `src/ami.js`  | AMI client, correlated `Originate` → `OriginateResponse`                |

### 4.3 Dialplan Contexts

Defined in `asterisk-config/extensions.conf`:

| Context         | Purpose                                                              |
|-----------------|----------------------------------------------------------------------|
| `from-internal` | Calls from local endpoint `1000`. Includes test extensions 100/200/1000. |
| `from-twilio`   | Inbound trunk traffic. Answers, then hands to `Stasis(node-stasis-app, ...)`. |
| `to-twilio`     | Outbound routing for softphone-initiated `_+X.` patterns.            |

Extensions of note:
- **100** — plays `hello-world` directly; no Node involvement (audio smoke test).
- **200** — hands the channel to Stasis (Node ARI control).
- **1000** — direct-dial to the extension; also handed to Stasis.
- **`_+X.`** (in `from-twilio`) — any E.164 DID → Stasis with args
  `[from-twilio, <DID>, <caller>]`.

### 4.4 SIP Endpoints

| Endpoint       | Type                            | Auth                     | Context      |
|----------------|----------------------------------|--------------------------|--------------|
| `1000`         | Local softphone (endpoint+aor)  | userpass `1000-auth`     | from-internal|
| `twilio-trunk` | Elastic SIP trunk endpoint      | outbound: `twilio-auth`; inbound: IP-identify | from-twilio  |

Trunk inbound is authorized by matching Twilio's signaling IPs against the
`[twilio-identify]` `match=` list. Trunk outbound is authenticated by a
credential list mirrored in `[twilio-auth]`.

---

## 5. Configuration Reference

Asterisk does **not** read `.env`. Any secret listed here must be mirrored in the
corresponding `.conf` file, and the container restarted.

### 5.1 `.env` Variables

| Variable                     | Purpose                                                     | Mirror in                                              |
|------------------------------|-------------------------------------------------------------|--------------------------------------------------------|
| `ASTERISK_IMAGE`             | Container image tag                                         | —                                                      |
| `EXTERNAL_MEDIA_ADDRESS`     | Public address advertised in SDP for RTP                    | `pjsip.conf` → `[transport-udp]` and `[transport-tcp]` |
| `EXTERNAL_SIGNALING_ADDRESS` | Public address advertised in Contact/Via                    | same as above                                          |
| `SIP_EXTENSION`              | Local extension number                                      | `pjsip.conf` `[1000]`                                  |
| `SIP_PASSWORD`               | Softphone password                                          | `pjsip.conf` `[1000-auth]` `password=`                 |
| `AMI_USER`, `AMI_PASSWORD`   | AMI login for the Node app                                  | `manager.conf` `[amiuser]`                             |
| `AMI_PORT`                   | Host-side published AMI port                                | (mapped in `docker-compose.yml`)                       |
| `ARI_USER`, `ARI_PASSWORD`   | ARI login for the Node app                                  | `ari.conf` `[ariuser]`                                 |
| `ARI_HTTP_PORT`              | Host-side published ARI/HTTP port                           | (mapped in `docker-compose.yml`)                       |
| `ARI_APP_NAME`               | Stasis application name registered by Node                  | referenced by `extensions.conf`                        |
| `NODE_APP_PORT`              | HTTP port the Node app listens on                           | published to host                                      |
| `TWILIO_TRUNK_SID`           | Reference only (not used by code)                           | —                                                      |
| `TWILIO_TERMINATION_URI`     | Trunk hostname (`<name>.pstn.twilio.com`)                   | `pjsip.conf` `[twilio-aor] contact=sip:<value>`        |
| `TWILIO_SIP_USERNAME`        | Credential-list username                                    | `pjsip.conf` `[twilio-auth] username=`                 |
| `TWILIO_SIP_PASSWORD`        | Credential-list password                                    | `pjsip.conf` `[twilio-auth] password=`                 |
| `TWILIO_DID`                 | Purchased Twilio phone number in E.164                      | `extensions.conf` `[globals] TWILIO_DID=`              |
| `PUBLIC_SIP_DOMAIN`          | Public host:port that Twilio's Origination points at        | —                                                      |
| `TWILIO_VERIFIED_NUMBERS`    | Comma-separated E.164 allowlist for outbound calls (trial)  | consumed by Node                                       |
| `INBOUND_GREETING_SOUND`     | Sound URI (no `sound:` prefix, no extension)                | played by Node in inbound handler                      |

### 5.2 Asterisk Configuration Files

- `asterisk.conf` — core paths, runuser=`asterisk`, verbose=3.
- `modules.conf` — `autoload=yes`, `noload => chan_sip.so`.
- `http.conf` — enables ARI's HTTP transport on `0.0.0.0:8088` (no TLS in lab).
- `ari.conf` — one non-read-only user (`ariuser`) with plaintext password.
- `manager.conf` — `amiuser` restricted by ACL to `172.16.0.0/12` and loopback.
- `pjsip.conf` — transports (UDP+TCP), endpoint `1000`, trunk endpoint/auth/aor/identify.
- `extensions.conf` — dialplan contexts described in §4.3.
- `rtp.conf`, `logger.conf` — port range and log channel configuration.

### 5.3 Sound Files

- Host: `sounds/custom/*` → Container: `/var/lib/asterisk/sounds/custom/*`
- Reference from code/dialplan as `sound:custom/<basename>` (no extension).
- Preferred format: **WAV, 8 kHz, 16-bit mono PCM** (or `ulaw`/`alaw`).
- Conversion helper: `scripts/convert-audio.sh <input>`.

---

## 6. HTTP API Reference

Base URL: `http://<host>:3000`

### 6.1 `GET /health`

Returns liveness/readiness of the ARI and AMI connections.

**Response `200 OK`**
```json
{
  "status": "ok",
  "ari": { "connected": true, "app": "node-stasis-app" },
  "ami": { "connected": true },
  "twilio": { "did": "+13862727164", "verifiedCount": 1 }
}
```

`status` is `"degraded"` when either connection is not up.

### 6.2 `POST /test-call`

Originates a **local** loopback call. Rings softphone `PJSIP/1000`; on answer,
sends the channel to dialplan extension `200 @ from-internal`, which enters
Stasis. No PSTN or Twilio traffic is generated.

**Response `200 OK`** — the actual `OriginateResponse` event:
```json
{
  "ok": true,
  "result": {
    "response": "Success",
    "reason": "4",
    "channel": "PJSIP/1000-00000001",
    "uniqueid": "1712000000.1",
    "calleridnum": "200"
  }
}
```

**Response `502 Bad Gateway`** — `Originate` failed or timed out.

### 6.3 `POST /place-call`

Originates a **real outbound PSTN call** through the Twilio trunk. The target
number must be in `TWILIO_VERIFIED_NUMBERS`.

**Request body** (optional)
```json
{ "to": "+201069035556" }
```

Defaults to the first entry of `TWILIO_VERIFIED_NUMBERS` when `to` is omitted.

**Response `200 OK`**
```json
{
  "ok": true,
  "result": {
    "response": "Success",
    "reason": "4",
    "channel": "PJSIP/twilio-trunk-00000002",
    "uniqueid": "1712001234.5",
    "calleridnum": "+13862727164"
  }
}
```

**Response `400 Bad Request`** — invalid JSON body or missing target.

**Response `403 Forbidden`** — target is not on the verified allowlist:
```json
{
  "ok": false,
  "error": "refusing to originate to +14155551212 — not in TWILIO_VERIFIED_NUMBERS",
  "hint": "Twilio trial accounts only permit calls to verified numbers.",
  "allowlist": ["+201069035556"]
}
```

**Response `502 Bad Gateway`** — Originate failed or timed out; body includes
`reason`, `channel`, `uniqueid` from the underlying event.

---

## 7. Call Flows

### 7.1 Local Softphone Test (Extension 200)

```
Softphone(1000) --INVITE--> Asterisk
Asterisk: exten 200 @ from-internal → Answer → Stasis(node-stasis-app)
Asterisk --StasisStart--> Node (ARI WS)
Node: classifyCall → "local" → handleLocal
Node: channel.play("sound:hello-world") → wait PlaybackFinished → hangup
```

### 7.2 Inbound Twilio Call

```
PSTN caller --> Twilio DID --> Origination URI --> Asterisk (public port 5060)
Asterisk: [twilio-identify] IP-match → [twilio-trunk] endpoint
Asterisk: exten +DID @ from-twilio → Answer → Stasis(node-stasis-app, from-twilio, +DID, +caller)
Asterisk --StasisStart--> Node
Node: classifyCall → "twilio-inbound" → handleInboundTwilio
Node: answer → play(INBOUND_GREETING) → wait PlaybackFinished → safeHangup
```

Failure modes (each ends in a clean hangup, never an orphaned channel):
- `answer` fails → `[twilio-inbound] answer error` → hangup(answer-failed).
- `play` fails → `[twilio-inbound] play error` → hangup(play-failed).
- `PlaybackFailed` event → hangup(playback-failed).
- Caller drops mid-playback → `StasisEnd` → no hangup needed.

### 7.3 Outbound PSTN Call

```
Client --POST /place-call {"to": "+E164"}--> Node HTTP
Node: allowlist check → ami.placeCall
Node --AMI Originate--> Asterisk
   Channel:     PJSIP/+E164@twilio-trunk
   Application: Stasis
   Data:        node-stasis-app,outbound,+E164
   Async:       true
Asterisk --INVITE--> Twilio --> PSTN callee rings
Callee answers → channel enters Stasis
Asterisk --OriginateResponse (ActionID)--> Node (AMI event)
Node: resolves the pending promise → HTTP 200 with real outcome
Asterisk --StasisStart--> Node
Node: classifyCall → "twilio-outbound" → handleOutboundTwilio
Node: channel.play("sound:hello-world") → hangup on finish
```

The correlation between `Originate` and `OriginateResponse` is done by a
random `ActionID` (UUID) stored in `state.pendingOriginates` on the AMI module.
A 45 s timeout guards against events that never arrive.

---

## 8. Deployment

### 8.1 Local Development

Prerequisites: Docker Engine 24+ with the Compose plugin.

```bash
cp .env.example .env       # then fill in secrets
cp node-app/.env.example node-app/.env
docker compose up -d --build
docker compose ps
docker compose logs -f node-app
```

Stop:
```bash
docker compose down          # keeps the asterisk-logs volume
docker compose down -v       # removes the volume too
```

### 8.2 VPS Production Deployment

The GitHub Actions workflow at `.github/workflows/deploy.yml` deploys to a VPS
over SSH on every push to `main` (also manually via `workflow_dispatch`).

**Required GitHub Secrets**

| Secret            | Purpose                                          |
|-------------------|--------------------------------------------------|
| `SSH_HOST`        | VPS hostname or public IP                        |
| `SSH_USER`        | SSH user with permission to run docker compose   |
| `SSH_PRIVATE_KEY` | Private key matching the deploy user's authorized_keys |

**Server-side prerequisites** (`/opt/asterisk-node-project` must already exist)

```bash
git clone <repo> /opt/asterisk-node-project
cd /opt/asterisk-node-project
cp .env.example .env      # populate with production secrets
# populate asterisk-config/*.conf with matching credentials
```

**What the workflow does**
```bash
cd /opt/asterisk-node-project
git pull origin main
docker compose pull || true
docker compose up -d --build
docker image prune -f
```

**Firewall requirements on the VPS**
- Inbound UDP 5060 (SIP from Twilio's signaling IPs).
- Inbound UDP 10000–10100 (RTP media from Twilio).
- Inbound TCP 3000 (HTTP API) — restrict to trusted networks or reverse-proxy.
- Do **not** expose 5038 (AMI) or 8088 (ARI) publicly.

### 8.3 Post-Deploy Validation

```bash
# Containers healthy
docker compose ps

# PJSIP endpoints registered
docker exec asterisk asterisk -rx 'pjsip show endpoints'

# ARI app is subscribed
docker exec asterisk asterisk -rx 'ari show apps'

# AMI user is connected
docker exec asterisk asterisk -rx 'manager show connected'

# Node health
curl -s http://localhost:3000/health | jq .
```

---

## 9. Operations & Observability

### 9.1 Logs

- **Node**: `docker compose logs -f node-app` (`[HTTP]`, `[ARI]`, `[AMI]`, `[BOOT]`, `[FATAL]`).
- **Asterisk (CLI)**: `docker exec -it asterisk asterisk -rvvv`.
- **Asterisk (files)**: persisted in the `asterisk-logs` volume.

### 9.2 Reconnection Behavior

Both ARI and AMI clients:
- Retry connection up to 30 times.
- Exponential backoff starting at 1 s, capped at 15 s.
- Boot failure of one interface does **not** crash the process — the health
  endpoint will report `"status": "degraded"`.

ARI uses the underlying `ari-client` WebSocket auto-reconnect; the `connected`
flag flips as `WebSocketReconnecting` / `WebSocketConnected` events fire.

AMI uses `keepConnected()` from `asterisk-manager` for socket-level recovery.

### 9.3 Signals

`SIGINT` and `SIGTERM` trigger a clean `process.exit(0)`. Docker sends `SIGTERM`
on `docker compose down`.

### 9.4 Key CLI Diagnostics

```bash
# Endpoint state
docker exec asterisk asterisk -rx 'pjsip show endpoints'
docker exec asterisk asterisk -rx 'pjsip show endpoint twilio-trunk'

# Trunk reachability
docker exec asterisk asterisk -rx 'pjsip show aor twilio-aor'

# Auth + IP-identify
docker exec asterisk asterisk -rx 'pjsip show auths'
docker exec asterisk asterisk -rx 'pjsip show identifies'

# HTTP transport
docker exec asterisk asterisk -rx 'http show status'

# Live SIP capture
docker exec -it asterisk asterisk -rx 'pjsip set logger on'
```

---

## 10. Security Model

This stack is a lab by default — its security posture must be tightened before
any production exposure.

| Concern             | Lab default                            | Production hardening                                |
|---------------------|----------------------------------------|-----------------------------------------------------|
| ARI transport       | Plain HTTP on `:8088`                  | Terminate TLS in front (nginx/Caddy) or enable TLS in `http.conf`; do not publish `:8088` publicly. |
| ARI credentials     | Plaintext `changeme-ari`               | Rotate, store in a secrets manager, never commit.   |
| AMI exposure        | Port 5038 published to host            | Remove the `5038:5038` mapping; reach AMI only inside `pbx-net`. |
| AMI ACL             | Allow `172.16.0.0/12` + loopback       | Narrow to the Node container's actual IP/CIDR.      |
| SIP peer allowlist  | `[twilio-identify]` with historical CIDRs | Verify against https://www.twilio.com/docs/sip-trunking/ip-addresses on every deploy. |
| Trunk credentials   | Plaintext in `pjsip.conf`              | Restrict file permissions; consider Asterisk's realtime backend. |
| SIP transport encryption | UDP only                          | Enable TLS + SRTP (`media_encryption`) on the trunk endpoint. |
| Outbound abuse      | Verified-number allowlist              | Keep in place; add rate limits + audit logging on `/place-call`. |
| HTTP API auth       | None                                   | Front with authenticating reverse proxy or add API-key middleware. |
| `chan_sip`          | Explicitly disabled (`noload`)         | Keep it disabled — legacy and vulnerable.           |

---

## 11. Troubleshooting

### 11.1 `pjsip show endpoints` shows the endpoint as `Unavailable`
The softphone has not registered, or its password is wrong.
Check `docker compose logs asterisk | grep -i auth`.

### 11.2 One-way / no audio
RTP/NAT problem. `external_media_address` in `pjsip.conf` must match how the
softphone or Twilio reaches the host. Ensure UDP `10000-10100` is published
and open on any intervening firewall.

### 11.3 `ari show apps` is empty
Node did not connect. Verify:
- `ARI_USER` / `ARI_PASSWORD` match `ari.conf`.
- `http show status` shows the HTTP transport bound.
- `docker compose logs node-app` for connect errors.

### 11.4 AMI authentication failure
`AMI_PASSWORD` mismatch with `manager.conf`, or the AMI ACL does not include
the Node container's IP. Widen the `permit=` line as needed.

### 11.5 Twilio inbound never arrives
- Origination URI in the Twilio Console is wrong or offline.
- Twilio's signaling IP is not covered by `[twilio-identify]` — refresh the
  CIDR list from Twilio's docs.
- Public firewall drops UDP 5060.

Enable a live trace with `pjsip set logger on` inside the Asterisk CLI.

### 11.6 Twilio outbound returns `403 Forbidden`
Credential-list mismatch. Compare `[twilio-auth]` values against the trunk's
attached credential list in the Twilio Console.

### 11.7 Twilio outbound returns `404`
Number is not valid E.164, or (on a trial account) not on the verified list.

### 11.8 `/place-call` returns `502` with `reason=1` / `reason=3`
`reason=1` — no answer / timeout. `reason=3` — call rejected by callee or
carrier. `reason=8` — congestion. Check Twilio's Console debug logs.

### 11.9 Port conflict on the host
Remap the host side in `docker-compose.yml` (e.g. `15060:5060/udp`) and
reconfigure the softphone accordingly.

### 11.10 Docker Desktop drops UDP after idle (macOS)
Known Docker Desktop VM issue. `docker compose restart asterisk` and
re-register the softphone.

---

## 12. Extension Guide

### 12.1 Add a New Inbound Behavior

1. Drop your audio into `sounds/custom/foo.wav` (convert with
   `scripts/convert-audio.sh` if needed).
2. Point the greeting at it: `INBOUND_GREETING_SOUND=custom/foo` in `.env`.
3. `docker compose up -d` (no rebuild required if only env changes).

For richer flows (IVR, DTMF, TTS bridging), extend `handleInboundTwilio` in
`node-app/src/ari.js`. The channel object exposes `getChannelVar`, `sendDTMF`,
`bridge`, `record`, `startSilence`, and full `ari-client` operations.

### 12.2 Add a New HTTP Endpoint

Add a route branch in `startHttpServer()` in `node-app/src/index.js`. Keep the
verified-number allowlist enforcement at the API boundary for any endpoint
that can trigger outbound PSTN calls.

### 12.3 Add a New SIP Endpoint

1. Append a new `[extNNN]` endpoint + `[extNNN-auth]` + `[extNNN]` AOR trio in
   `pjsip.conf`.
2. Reload PJSIP: `docker exec asterisk asterisk -rx 'pjsip reload'`.
3. Register the new softphone with those credentials.

### 12.4 Add a New Dialplan Context

Edit `extensions.conf`, then reload: `docker exec asterisk asterisk -rx 'dialplan reload'`.

### 12.5 Bridge Two Channels

Inside a Stasis handler:
```js
const bridge = client.Bridge();
await bridge.create({ type: 'mixing' });
await bridge.addChannel({ channel: channel.id });
await bridge.addChannel({ channel: otherChannel.id });
```

### 12.6 Record a Call

```js
await channel.record({
  name: `call-${channel.id}`,
  format: 'wav',
  maxDurationSeconds: 300,
});
```
Recordings land in `/var/spool/asterisk/recording/` inside the container — add
a volume mount if you want them on the host.

---

## Appendix A — Glossary

- **ARI** — Asterisk REST Interface. Modern, event-driven, WebSocket-backed.
- **AMI** — Asterisk Manager Interface. Legacy TCP text protocol, still the
  most robust path for `Originate`.
- **Stasis** — Asterisk application that hands channels to an ARI client.
- **PJSIP** (`chan_pjsip`) — Modern SIP channel driver, successor to `chan_sip`.
- **AOR** — Address of Record. Where a SIP endpoint can be contacted.
- **DID** — Direct Inward Dialing number. Your Twilio-purchased phone number.
- **Elastic SIP Trunk** — Twilio's SIP trunking product providing PSTN access.
- **Origination** (Twilio) — Inbound: Twilio → your PBX.
- **Termination** (Twilio) — Outbound: your PBX → Twilio → PSTN.
- **E.164** — International phone number format (e.g. `+14155550100`).

## Appendix B — External References

- Asterisk documentation: https://docs.asterisk.org/
- ARI reference: https://docs.asterisk.org/Asterisk_20_Documentation/API_Documentation/Asterisk_REST_Interface/
- PJSIP configuration: https://docs.asterisk.org/Configuration/Channel-Drivers/SIP/Configuring-res_pjsip/
- Twilio Elastic SIP Trunking: https://www.twilio.com/docs/sip-trunking
- Twilio signaling IPs: https://www.twilio.com/docs/sip-trunking/ip-addresses
- `ari-client` (npm): https://www.npmjs.com/package/ari-client
- `asterisk-manager` (npm): https://www.npmjs.com/package/asterisk-manager
