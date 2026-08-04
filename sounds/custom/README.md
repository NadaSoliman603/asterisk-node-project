# Custom sound files

This directory is bind-mounted into the Asterisk container at
`/var/lib/asterisk/sounds/custom/` (see `docker-compose.yml`). Anything
you drop here is playable via ARI as `sound:custom/<basename>`
(no extension — Asterisk picks the best-matching format).

**Format requirement**: WAV, 8 kHz, 16-bit mono PCM (or `ulaw` / `alaw`).
Use `scripts/convert-audio.sh <input>` to convert any source file.

Files:
- `greeting.wav` — 2-second 440 Hz sine tone placeholder. **Replace** this
  with your real recording. It is *not* meant to be shipped as a real
  greeting; it exists so the pipeline can be validated end-to-end before
  the real audio arrives.
