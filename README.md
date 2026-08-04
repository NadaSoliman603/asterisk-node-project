# Asterisk + Node.js (ARI/AMI) Docker Lab

A minimal, reproducible local dev stack: **Asterisk PBX** and a **Node.js**
integration that speaks to it over **ARI** (event-driven call control) and
**AMI** (legacy events + originate).

Target platform: **macOS / Windows with Docker Desktop, or Linux**. Uses
bridge networking so it works on all three. Host networking is intentionally
avoided because it does not work on Docker Desktop for Mac/Windows.

---

## Layout

```
asterisk-node-project/
├── docker-compose.yml       # orchestration
├── .env                     # shared env for compose + services
├── asterisk-config/         # bind-mounted into /etc/asterisk (read-only)
│   ├── asterisk.conf        # core paths / runuser
│   ├── modules.conf         # autoload; blocks chan_sip
│   ├── logger.conf, rtp.conf
│   ├── pjsip.conf           # endpoint 1000 + Twilio trunk (endpoint/auth/aor/identify)
│   ├── extensions.conf      # from-internal, from-twilio, to-twilio
│   ├── manager.conf         # AMI user + ACL
│   ├── ari.conf             # ARI user
│   └── http.conf            # HTTP server on 8088 (ARI transport)
├── node-app/
│   ├── Dockerfile
│   ├── package.json
│   ├── .env / .env.example  # runtime + template
│   └── src/
│       ├── index.js         # /health, /test-call, /place-call
│       ├── ari.js           # ARI client + trunk-aware StasisStart handler
│       └── ami.js           # AMI client + originateTestCall + placeCall (Twilio)
├── .env / .env.example      # shared config; .env is git-ignored
├── .gitignore
└── README.md
```

---

## Prerequisites

- Docker Engine 24+ with the Compose plugin (`docker compose version`)
- (For end-to-end voice test) a SIP softphone: **Zoiper**, **MicroSIP**,
  **Linphone**, or similar
- Ports **5060/udp**, **10000-10100/udp**, **8088/tcp**, **5038/tcp**, and
  **3000/tcp** free on the host

---

## Configure

1. Copy or edit `./.env`. Change every `changeme-*` value before doing
   anything beyond local play.
2. **Mirror the same passwords** in the Asterisk `.conf` files. Asterisk does
   not read `.env`, so the following must be kept in sync manually:

   | `.env` variable   | file / key                                        |
   |-------------------|---------------------------------------------------|
   | `SIP_PASSWORD`    | `asterisk-config/pjsip.conf` → `[1000-auth] password=` |
   | `AMI_PASSWORD`    | `asterisk-config/manager.conf` → `[amiuser] secret=`    |
   | `ARI_PASSWORD`    | `asterisk-config/ari.conf` → `[ariuser] password=`      |
   | `EXTERNAL_MEDIA_ADDRESS` / `EXTERNAL_SIGNALING_ADDRESS` | `asterisk-config/pjsip.conf` → `[transport-udp]` |

3. If you'll register a softphone from another machine on your LAN, set
   `EXTERNAL_MEDIA_ADDRESS` and `EXTERNAL_SIGNALING_ADDRESS` (in both `.env`
   and `pjsip.conf`) to your host's LAN IP.

---

## Start / stop

```bash
# from asterisk-node-project/
docker compose up -d --build
docker compose ps
docker compose logs -f node-app
docker compose logs -f asterisk

docker compose down          # stop + remove containers, keep logs volume
docker compose down -v       # also drop the asterisk-logs volume
```

---

## Validation

Run these in order — each mirrors the acceptance criteria in the spec.

**1. Containers healthy**
```bash
docker compose ps
# both services should be "running"; asterisk "healthy"
```

**2. Asterisk CLI**
```bash
docker exec -it asterisk asterisk -rvvv
# inside the CLI:
pjsip show endpoints        # → 1000 listed
ari show apps               # → node-stasis-app (Subscribed to: …)
manager show connected      # → amiuser connected from the pbx-net subnet
exit
```

**3. Node health endpoint**
```bash
curl -s http://localhost:3000/health | jq .
# → { "status": "ok", "ari": { "connected": true, ... }, "ami": { "connected": true } }
```

**4. End-to-end SIP call**

Register a softphone against Asterisk:

| field       | value                                  |
|-------------|----------------------------------------|
| Server/host | `127.0.0.1` (or your LAN IP)           |
| Port        | `5060`                                 |
| Transport   | UDP                                    |
| Username    | `1000`                                 |
| Password    | value of `SIP_PASSWORD`                |
| Domain/realm| same as server                         |

Then dial any of:
- **100** — plays "hello-world" from the dialplan directly (no Node). Sanity check for audio + RTP.
- **200** — hands off to the Stasis app. Watch `docker compose logs -f node-app` for `[ARI] StasisStart …`.
- **1000** — also hands off to Stasis (per the dialplan in this lab).

**5. Originate from AMI**
```bash
curl -s -X POST http://localhost:3000/test-call | jq .
# The registered softphone at extension 1000 should ring; when answered,
# the call is bridged to exten 200 → Stasis. Node logs a StasisStart event.
```

---

## Troubleshooting

### `pjsip show endpoints` shows the endpoint as `Unavailable`
The softphone hasn't registered yet, or its password is wrong. Check the
softphone log and `docker compose logs asterisk | grep -i auth`.

### Call connects but there's no audio (one-way or dead air)
RTP/NAT problem. On macOS/Windows Docker Desktop, one-way audio often means
the softphone is sending RTP to a private container IP instead of the host.
Fix by:
- ensuring `external_media_address` / `external_signaling_address` in
  `pjsip.conf` match how the softphone reaches the host (`127.0.0.1` for a
  softphone on the same machine; LAN IP for a softphone elsewhere), and
- confirming the `10000-10100/udp` range is published (see
  `docker compose ps`).

### `ari show apps` is empty
Node hasn't finished connecting. Check `docker compose logs node-app`. Common
causes: wrong `ARI_PASSWORD`, wrong `ARI_USER`, or ARI/HTTP disabled. Verify
inside the container: `docker exec asterisk asterisk -rx 'http show status'`.

### AMI auth failure in node-app logs
Check that `AMI_PASSWORD` in `.env` matches `secret=` in `manager.conf`, and
that the ACL in `manager.conf` covers your Docker network. If you've changed
the compose network's subnet, widen the `permit=` line accordingly.

### Port conflict on 5060 / 8088 / 5038 / 3000
Something else on the host is bound to that port. Either stop it, or remap
the host side in `docker-compose.yml` (e.g. `"15060:5060/udp"`) and update
your softphone accordingly.

### Everything just crashes on macOS
Docker Desktop's VM sometimes drops UDP after long idle. `docker compose
restart asterisk` and re-register the softphone.

---

## Security notes

This lab is intentionally permissive for local development:

- ARI/AMI passwords are plaintext placeholders — **change them** for any
  environment beyond `localhost`.
- ARI runs over plain HTTP. Do not expose port 8088 publicly without TLS.
- AMI is ACL-restricted to the Docker bridge subnet but the port is still
  published to the host. In production, drop the `5038:5038` mapping and
  reach AMI only from inside the compose network.
- `chan_sip` is not loaded — this project uses `chan_pjsip` exclusively as
  required by the spec.

---

## Twilio SIP Trunk Setup

The stack ships with a **Twilio Elastic SIP Trunk** endpoint alongside the
local `[1000]` softphone extension. Once configured:

- **Inbound** — a real caller dials your Twilio DID → Twilio's Origination
  URI points at your public SIP endpoint → Asterisk `[from-twilio]` context
  → `Stasis(node-stasis-app)` → Node's `handleInboundTwilio()`.
- **Outbound** — Node calls `POST /place-call` → `ami.placeCall()` sends an
  AMI `Originate` targeting `PJSIP/<E.164>@twilio-trunk` → Asterisk authenticates
  outbound via the credential list on `[twilio-auth]` → Twilio → PSTN → callee
  answers → the answered channel enters Stasis so Node can drive it.

### 1. Create the Elastic SIP Trunk in the Twilio Console

Twilio Console → **Elastic SIP Trunking → Trunks → Create new trunk**.

- **Termination URI**: shown on the trunk detail page as
  `<name>.pstn.twilio.com`. Save it — it goes into `TWILIO_TERMINATION_URI`
  and into `asterisk-config/pjsip.conf` under `[twilio-aor] contact=`.
- **Authentication → Credential Lists**: create a credential list with a
  username + password. Save both — they go into `TWILIO_SIP_USERNAME` /
  `TWILIO_SIP_PASSWORD` and into `[twilio-auth]` in `pjsip.conf`.
- **Origination URI**: add an entry pointing at your **public** SIP
  endpoint. Format: `sip:<PUBLIC_SIP_DOMAIN>;transport=tcp` (or `udp` from
  a real public IP). See section 3 below for what to put here.
- **Numbers → Assign existing**: assign your purchased DID
  (`+13862727164`) to the trunk. Inbound calls to that DID will now be
  routed via the Origination URI.

### 2. Sync credentials

Asterisk does not read `.env`. After filling in `.env`, mirror these values
manually in `asterisk-config/`:

| `.env` variable          | `.conf` location                                            |
|--------------------------|-------------------------------------------------------------|
| `TWILIO_TERMINATION_URI` | `pjsip.conf` → `[twilio-aor] contact=sip:<value>`           |
| `TWILIO_SIP_USERNAME`    | `pjsip.conf` → `[twilio-auth] username=<value>`             |
| `TWILIO_SIP_PASSWORD`    | `pjsip.conf` → `[twilio-auth] password=<value>`             |
| `TWILIO_DID`             | `extensions.conf` → `[globals] TWILIO_DID=<value>`          |
| `EXTERNAL_MEDIA_ADDRESS` / `EXTERNAL_SIGNALING_ADDRESS` | `pjsip.conf` → both `[transport-udp]` and `[transport-tcp]` |

Then `docker compose restart asterisk`.

> **Verify Twilio's signaling IPs.** `pjsip.conf` includes a `[twilio-identify]`
> block with historical Twilio CIDR ranges. Twilio updates this list — check
> <https://www.twilio.com/docs/sip-trunking/ip-addresses> and edit the
> `match=` lines if anything changed. A stale list silently rejects inbound.

### 3. Public SIP endpoint — ngrok vs hosted

Twilio has to reach your Asterisk from the public internet. Two options:

**A. Local dev with ngrok (TCP tunnel)**

Free-tier ngrok doesn't do UDP, so we tunnel SIP over TCP (Asterisk is
listening on both — see `[transport-tcp]` in `pjsip.conf`). Media (RTP) is
UDP, which won't traverse ngrok — meaning **audio won't work end-to-end
with ngrok**. This is only useful to prove signaling: you'll see the INVITE
arrive, hit `[from-twilio]`, and fire `StasisStart`. If you need audio too,
skip to option B.

```bash
brew install ngrok        # macOS
ngrok tcp 5060            # exposes tcp://0.tcp.ngrok.io:<port> → localhost:5060
```

Then in the Twilio Console → Origination URI:
`sip:0.tcp.ngrok.io:<port>;transport=tcp`

In `.env`: `PUBLIC_SIP_DOMAIN=0.tcp.ngrok.io:<port>`

Also update `external_signaling_address` / `external_media_address` in
both transports in `pjsip.conf` to `0.tcp.ngrok.io` — otherwise PJSIP
advertises `127.0.0.1` in SDP and Twilio can't reach the media.

**B. Hosted (real public IP)**

Run the stack on a VPS with a public IP or DNS name. Open UDP 5060 and
UDP 10000–10100 in the firewall. In `.env`:
```
EXTERNAL_MEDIA_ADDRESS=<your.public.ip>
EXTERNAL_SIGNALING_ADDRESS=<your.public.ip>
PUBLIC_SIP_DOMAIN=<your.public.ip>:5060   # or sip.example.com:5060
```
In Twilio Console → Origination URI: `sip:<PUBLIC_SIP_DOMAIN>` (UDP by default).

This is the only path where inbound *audio* works, because Twilio can send
RTP directly to the published UDP ports.

### 4. End-to-end tests

**Inbound** — call `+1 386 272 7164` from your **verified caller ID**
(`+20 10 69035556` on the trial account). Then:

```bash
# In one terminal
PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH" \
  docker logs -f node-app

# In another
PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH" \
  docker exec -it asterisk asterisk -rvvv
```

Expected trace:

```
# asterisk CLI
-- Executing [+13862727164@from-twilio:1] NoOp("PJSIP/twilio-trunk-...", "INBOUND from Twilio: +201069035556 → +13862727164") in new stack
-- Executing [+13862727164@from-twilio:2] Answer(...)
-- Executing [+13862727164@from-twilio:3] Stasis("node-stasis-app,from-twilio,+13862727164,+201069035556")

# node-app logs
[ARI] StasisStart [twilio-inbound] channel=PJSIP/twilio-trunk-00000001 id=... from=+201069035556 to=+13862727164 args=["from-twilio","+13862727164","+201069035556"]
[ARI] [twilio-inbound] answering call from +201069035556 → DID +13862727164
```

**Outbound** —
```bash
curl -X POST http://localhost:3000/place-call \
     -H 'Content-Type: application/json' \
     -d '{"to":"+201069035556"}'
```

The verified number should ring. Expected response body (after the call
is answered or times out — this endpoint waits for the real
`OriginateResponse`, not the queue ack):

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

If the target is not in `TWILIO_VERIFIED_NUMBERS`, the endpoint refuses
with **HTTP 403** — Twilio's trial account would reject it anyway, so
we fail fast in the app.

### 5. Validation checklist

```bash
# 1. Trunk endpoint registered
docker exec asterisk asterisk -rx 'pjsip show endpoints' | grep twilio-trunk
# Endpoint:  twilio-trunk     Not in use    0 of inf

# 2. Trunk identify + auth loaded
docker exec asterisk asterisk -rx 'pjsip show identifies'
docker exec asterisk asterisk -rx 'pjsip show auths'

# 3. Outbound reachability (Asterisk qualifies the AOR periodically)
docker exec asterisk asterisk -rx 'pjsip show aor twilio-aor'
# → Contact ... Avail   <RTT>

# 4. Inbound classifier (place a real call from the verified number)
docker logs -f node-app | grep 'StasisStart \[twilio-inbound\]'

# 5. Outbound OriginateResponse (real, not "queued")
curl -sX POST http://localhost:3000/place-call \
     -H 'Content-Type: application/json' -d '{}' | jq .
```

### Common gotchas

- **`403 Forbidden` from Twilio on outbound** — credential list mismatch.
  Compare the values on the trunk in the Twilio Console with `[twilio-auth]`
  in `pjsip.conf`. Also check the trunk has the credential list attached
  (not just created).
- **`404` from Twilio on outbound** — the number isn't valid E.164, or
  (on trial) not on the verified list.
- **No inbound arrives at all** — either your Origination URI is wrong,
  ngrok tunnel is down, or Twilio's signaling IP isn't in `[twilio-identify]`.
  Run `pjsip set logger on` in the Asterisk CLI and place a test call —
  if nothing shows, the packets never reach Asterisk.
- **One-way audio on inbound** — `external_media_address` in `pjsip.conf`
  is still `127.0.0.1`. Change it to the same public IP/DNS as
  `PUBLIC_SIP_DOMAIN` and restart Asterisk.
- **Everything works, but Node never sees `StasisStart`** — the dialplan
  didn't call `Stasis()`. Confirm `[from-twilio]` is the context on the
  `twilio-trunk` endpoint (`pjsip show endpoint twilio-trunk`).

---

## Inbound Greeting Message

Every inbound Twilio call gets a static voice greeting: answer → play →
wait for `PlaybackFinished` → hang up. Handled entirely in the Node ARI
app (`src/ari.js` → `handleInboundTwilio`). The local `[1000]` softphone
path is deliberately untouched.

### Where the audio file lives

| Host path                     | Container path                            |
|-------------------------------|-------------------------------------------|
| `sounds/custom/greeting.wav`  | `/var/lib/asterisk/sounds/custom/greeting.wav` |

The bind mount is declared in `docker-compose.yml`
(`./sounds/custom:/var/lib/asterisk/sounds/custom:ro`). Anything you drop
into `sounds/custom/` on the host becomes playable in the container.

### Format requirements

Asterisk plays sound files best as **WAV, 8 kHz, 16-bit mono PCM** (or
`ulaw` / `alaw`). Anything else risks transcoding CPU cost or codec
mismatches with Twilio (which itself only uses ulaw/alaw).

Convert any input file with the provided helper:

```bash
# From the project root:
scripts/convert-audio.sh path/to/my-recording.mp3
# → sounds/custom/my-recording.wav
```

The script wraps:
```bash
ffmpeg -y -i <input> -ar 8000 -ac 1 -acodec pcm_s16le <output>
```

Confirm the result:
```bash
file sounds/custom/my-recording.wav
# → RIFF ... WAVE audio, Microsoft PCM, 16 bit, mono 8000 Hz
```

### Swapping the greeting

Two options:

**1. Replace `greeting.wav` in place.** Fastest — the sound file is bind-mounted,
so no rebuild / restart is needed. Asterisk re-opens the file on each play.

**2. Add a new file and point the app at it.** Drop e.g.
`sounds/custom/friday.wav`, then in `.env`:
```
INBOUND_GREETING_SOUND=custom/friday
```
`docker compose up -d` (or `docker restart node-app`) to pick up the new env.

> Note the URI form: **no `sound:` prefix, no file extension**. The Node
> app adds `sound:` and Asterisk picks the extension.

### Repo state on first clone

`sounds/custom/greeting.wav` in this repo is a **2-second 440 Hz sine tone
placeholder** — proof-of-plumbing, not a real greeting. Replace it before
the trunk goes live.

### Validation — file is visible to Asterisk

Without needing a real inbound call, prove the file plays end-to-end:

```bash
# 1. Confirm the mount landed
PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH" \
  docker exec asterisk ls -la /var/lib/asterisk/sounds/custom/

# 2. Trigger a synthetic playback via a Local channel (no softphone needed)
PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH" docker exec asterisk \
  asterisk -rx 'channel originate Local/s@from-internal application Playback custom/greeting'
```
The Asterisk CLI (`asterisk -rvvv`) should show:
```
-- Playing 'custom/greeting.slin' (language 'en')
```
(or `.wav`, depending on which format Asterisk picks — either is a pass.)

### Validation — end-to-end via a real inbound call

Call `+1 386 272 7164` from your verified number (`+20 10 69035556`). A
full successful trace looks like:

**Asterisk CLI**
```
-- Executing [+13862727164@from-twilio:1] NoOp(...) "INBOUND from Twilio: +201069035556 → +13862727164"
-- Executing [+13862727164@from-twilio:2] Answer(...)
-- Executing [+13862727164@from-twilio:3] Stasis(...) "node-stasis-app,from-twilio,+13862727164,+201069035556"
    -- Channel PJSIP/twilio-trunk-... entered Stasis
    -- <PJSIP/twilio-trunk-...> Playing 'custom/greeting.slin' (language 'en')
== Spawn extension (from-twilio, +13862727164, 3) exited non-zero on 'PJSIP/twilio-trunk-...'
-- Channel PJSIP/twilio-trunk-... left 'node-stasis-app' — hangup
```

**node-app logs**
```
[ARI] StasisStart [twilio-inbound] channel=PJSIP/twilio-trunk-00000004 id=... from=+201069035556 to=+13862727164 args=["from-twilio","+13862727164","+201069035556"]
[ARI] [twilio-inbound] answering call from +201069035556 → DID +13862727164
[ARI] [twilio-inbound] answered channel=PJSIP/twilio-trunk-00000004
[ARI] [twilio-inbound] playback started id=... media=sound:custom/greeting
[ARI] [twilio-inbound] playback finished id=... — hanging up
[ARI] [twilio-inbound] hung up channel=PJSIP/twilio-trunk-00000004 reason=playback-finished
```

### Failure paths (handled, not crashes)

The inbound handler survives each of these without leaking a channel:

| Failure                             | Log line                                                | Then      |
|-------------------------------------|---------------------------------------------------------|-----------|
| `answer` fails (rare — channel gone)| `[twilio-inbound] answer error: …`                     | safe hangup |
| `play` fails (bad filename, no read)| `[twilio-inbound] play(sound:custom/x) error: …`       | safe hangup |
| Media stalls mid-way                | `[twilio-inbound] playback FAILED id=… evt=…`          | safe hangup |
| Caller hangs up during playback     | `[twilio-inbound] caller hung up during playback id=…` | no-op (channel gone) |

Explicitly not used: `setTimeout()` — playback length varies with file
and codec, so we wait for the real `PlaybackFinished` event instead.
