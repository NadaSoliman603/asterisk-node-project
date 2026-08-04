#!/usr/bin/env bash
# Convert any audio file to the format Asterisk prefers for `sound:` playback:
# WAV, 8 kHz, 16-bit mono PCM.
#
# Usage:
#   scripts/convert-audio.sh <input> [output]
#
# Default output: sounds/custom/<input-basename>.wav
#
# Requires ffmpeg on PATH.
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <input> [output.wav]" >&2
  exit 64
fi

INPUT=$1
OUTPUT=${2:-}
if [[ -z ${OUTPUT} ]]; then
  base=$(basename "${INPUT%.*}")
  script_dir=$(cd "$(dirname "$0")" && pwd)
  OUTPUT="${script_dir}/../sounds/custom/${base}.wav"
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found. Install with 'brew install ffmpeg' (macOS) or your distro's package manager." >&2
  exit 127
fi

mkdir -p "$(dirname "$OUTPUT")"
ffmpeg -y -i "$INPUT" -ar 8000 -ac 1 -acodec pcm_s16le "$OUTPUT"
echo "wrote: $OUTPUT"
file "$OUTPUT" 2>/dev/null || true
