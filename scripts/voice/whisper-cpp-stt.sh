#!/usr/bin/env bash
set -euo pipefail

input_path="${1:?input audio path required}"
model_path="${2:?whisper model path required}"
language="${3:-auto}"

if [[ ! -f "$input_path" ]]; then
  echo "Input audio file not found: $input_path" >&2
  exit 1
fi

if [[ ! -f "$model_path" ]]; then
  echo "Whisper model file not found: $model_path" >&2
  exit 1
fi

exec whisper-cli \
  --model "$model_path" \
  --file "$input_path" \
  --language "$language" \
  --no-prints \
  --no-timestamps
