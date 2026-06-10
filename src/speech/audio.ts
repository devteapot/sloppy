// Shared audio helpers for the speech pipeline. Audio crosses the SLOP
// boundary as base64 strings (affordance params/results are JSON), mirroring
// how images are carried as base64 in `ImageContentBlock`.

import type { PcmFormat } from "./types";

/** Decode a base64 string into raw bytes. */
export function fromBase64(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data, "base64"));
}

/** Encode raw bytes into a base64 string. */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Strip a trailing slash so endpoints can be joined consistently. */
export function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Wrap raw PCM16 in a minimal 44-byte WAV header so it can travel as a
 * self-describing clip (e.g. one robot `/speaker play` affordance invoke).
 */
export function wavFromPcm16(format: PcmFormat, pcm: Uint8Array): Uint8Array {
  const blockAlign = format.channels * 2;
  const byteRate = format.sampleRate * blockAlign;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);

  const wav = new Uint8Array(44 + pcm.byteLength);
  wav.set(new Uint8Array(header), 0);
  wav.set(pcm, 44);
  return wav;
}
