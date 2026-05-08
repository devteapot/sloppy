import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ImageContentBlock, MessageContentBlock } from "../llm/types";

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

const IMAGE_LINK_PATTERN = /\[Image #\d+\]\((file:\/\/[^)]+)\)/g;

export function parseUserMessageBlocks(text: string): MessageContentBlock[] {
  const blocks: MessageContentBlock[] = [];
  let cursor = 0;

  for (const match of text.matchAll(IMAGE_LINK_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const url = match[1];
    if (!url) continue;

    const image = tryLoadImage(url);
    if (!image) continue;

    if (start > cursor) {
      pushText(blocks, text.slice(cursor, start));
    }
    blocks.push(image);
    cursor = end;
  }

  if (cursor < text.length) {
    pushText(blocks, text.slice(cursor));
  }

  if (blocks.length === 0) {
    blocks.push({ type: "text", text });
  }

  return blocks;
}

function pushText(blocks: MessageContentBlock[], chunk: string): void {
  const trimmed = chunk.replace(/^[ \t]+|[ \t]+$/g, "");
  if (!trimmed) return;
  blocks.push({ type: "text", text: chunk });
}

function tryLoadImage(url: string): ImageContentBlock | null {
  let filesystemPath: string;
  try {
    filesystemPath = fileURLToPath(url);
  } catch {
    return null;
  }
  const ext = path.extname(filesystemPath).toLowerCase();
  const mediaType = IMAGE_MIME_TYPES[ext];
  if (!mediaType) return null;
  try {
    const data = readFileSync(filesystemPath).toString("base64");
    return { type: "image", mediaType, data };
  } catch {
    return null;
  }
}
