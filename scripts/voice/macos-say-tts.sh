#!/usr/bin/env bash
set -euo pipefail

text="${1:?text required}"
output_path="${2:?output path required}"
voice="${3:-Samantha}"
format="${4:-wav}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

text_file="$tmp_dir/input.txt"
aiff_file="$tmp_dir/output.aiff"

printf '%s' "$text" > "$text_file"
say -v "$voice" -o "$aiff_file" -f "$text_file"

case "$format" in
  wav)
    exec ffmpeg -hide_banner -loglevel error -y -i "$aiff_file" -ar 24000 -ac 1 "$output_path"
    ;;
  mp3|aac|flac|opus)
    exec ffmpeg -hide_banner -loglevel error -y -i "$aiff_file" "$output_path"
    ;;
  pcm)
    exec ffmpeg -hide_banner -loglevel error -y -i "$aiff_file" -f s16le -ar 24000 -ac 1 "$output_path"
    ;;
  *)
    echo "Unsupported TTS output format: $format" >&2
    exit 1
    ;;
esac
