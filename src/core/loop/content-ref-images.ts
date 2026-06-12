import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ImageContentBlock } from "../../llm/types";
import { debug } from "../debug";
import { IMAGE_MIME_TYPES } from "../user-message";

/**
 * SLOP content_ref shapes we recognise as loadable images: an object under a
 * `content_ref`/`contentRef` key with an `image/*` mime and a `file://` URI.
 * file:// only — providers that return these run on the same host (SLOP has
 * no in-protocol content fetch); remote URIs are deliberately ignored.
 */
interface ImageContentRef {
  mime: string;
  uri: string;
  summary?: string;
  /** Taken from numeric width/height siblings of the ref, when present. */
  width?: number;
  height?: number;
}

const REF_KEYS = ["content_ref", "contentRef"] as const;
const MAX_WALK_DEPTH = 3;
const ALLOWED_MIMES = new Set(Object.values(IMAGE_MIME_TYPES));

export function findImageContentRefs(data: unknown, maxRefs = 2): ImageContentRef[] {
  const refs: ImageContentRef[] = [];
  walk(data, 0, refs, maxRefs);
  return refs;
}

function walk(value: unknown, depth: number, refs: ImageContentRef[], maxRefs: number): void {
  if (refs.length >= maxRefs || depth > MAX_WALK_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, depth + 1, refs, maxRefs);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of REF_KEYS) {
    const ref = record[key];
    if (isImageContentRef(ref) && refs.length < maxRefs) {
      const raw = ref as unknown as Record<string, unknown>;
      refs.push({
        mime: ref.mime,
        uri: ref.uri,
        summary: typeof raw.summary === "string" ? raw.summary : undefined,
        width: numericDim(record.width),
        height: numericDim(record.height),
      });
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if ((REF_KEYS as readonly string[]).includes(key)) continue;
    walk(child, depth + 1, refs, maxRefs);
  }
}

function numericDim(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isImageContentRef(value: unknown): value is ImageContentRef {
  if (value === null || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.mime === "string" &&
    ref.mime.startsWith("image/") &&
    typeof ref.uri === "string" &&
    ref.uri.startsWith("file://")
  );
}

export type LoadedContentRefImage = {
  bytes: Buffer;
  mediaType: string;
  uri: string;
  summary?: string;
  width?: number;
  height?: number;
};

/**
 * Resolve image content_refs in a tool result into loaded byte records.
 * Best-effort: anything unreadable, oversized, or off the mime allowlist is
 * skipped with a debug note — never an error into the tool result.
 */
export async function loadContentRefImageRecords(
  data: unknown,
  options: { maxBytes: number },
): Promise<LoadedContentRefImage[]> {
  const records: LoadedContentRefImage[] = [];
  for (const ref of findImageContentRefs(data)) {
    try {
      const filePath = fileURLToPath(ref.uri);
      const ext = path.extname(filePath).toLowerCase();
      const mediaType = IMAGE_MIME_TYPES[ext];
      if (!mediaType || !ALLOWED_MIMES.has(ref.mime)) {
        debug("loop", "content_ref image skipped: mime/extension not allowed", { ref });
        continue;
      }
      const stat = await fs.stat(filePath);
      if (stat.size > options.maxBytes) {
        debug("loop", "content_ref image skipped: too large", {
          uri: ref.uri,
          size: stat.size,
          maxBytes: options.maxBytes,
        });
        continue;
      }
      const bytes = await fs.readFile(filePath);
      records.push({
        bytes,
        mediaType,
        uri: ref.uri,
        summary: ref.summary,
        width: ref.width,
        height: ref.height,
      });
    } catch (error) {
      debug("loop", "content_ref image skipped: unreadable", {
        uri: ref.uri,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return records;
}

/** Records as bare image blocks (legacy shape kept for tests/utilities). */
export async function loadContentRefImages(
  data: unknown,
  options: { maxBytes: number },
): Promise<ImageContentBlock[]> {
  const records = await loadContentRefImageRecords(data, options);
  return records.map((record) => ({
    type: "image",
    mediaType: record.mediaType,
    data: record.bytes.toString("base64"),
  }));
}
