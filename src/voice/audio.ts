// Shared audio helpers for the voice plugin. Audio crosses the SLOP boundary as
// base64 strings (affordance params/results are JSON), mirroring how images are
// carried as base64 in `ImageContentBlock`. These helpers normalize between the
// base64 wire form and the raw byte form the adapters work with.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Decode a base64 string into raw bytes. */
export function fromBase64(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data, "base64"));
}

/** Encode raw bytes into a base64 string. */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Normalize either raw bytes or a base64 string into raw bytes. */
export function toAudioBytes(audio: Uint8Array | string): Uint8Array {
  return typeof audio === "string" ? fromBase64(audio) : audio;
}

/**
 * Wrap audio bytes in a Blob suitable for `fetch` bodies / FormData parts. The
 * cast sidesteps the TS 5.7 `Uint8Array<ArrayBufferLike>` vs `BlobPart`
 * mismatch; the bytes are a valid blob part at runtime.
 */
export function toAudioBlob(bytes: Uint8Array, type: string): Blob {
  return new Blob([bytes as unknown as BlobPart], { type });
}

const MIME_EXTENSIONS: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
};

/** Best-effort filename for multipart uploads that infer format from extension. */
export function audioFileName(mimeType: string | undefined, fallback = "audio"): string {
  const ext = mimeType ? (MIME_EXTENSIONS[mimeType.toLowerCase()] ?? "wav") : "wav";
  return `${fallback}.${ext}`;
}

const FORMAT_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/opus",
  pcm: "audio/pcm",
};

/** Map a synthesis output format to its MIME type. */
export function formatToMimeType(format: string | undefined): string {
  return (format && FORMAT_MIME[format]) || "audio/mpeg";
}

/** Strip a trailing slash so endpoints can be joined consistently. */
export function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}
