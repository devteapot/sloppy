import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseUserMessageBlocks } from "../src/core/user-message";

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 0x7),
]);

describe("parseUserMessageBlocks", () => {
  test("substitutes a registry ref when registerImage returns a path", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "user-message-"));
    try {
      const imagePath = path.join(dir, "shot.png");
      writeFileSync(imagePath, PNG_BYTES);
      const uri = pathToFileURL(imagePath).href;

      const registered: Array<{ mediaType: string; data: string; sourceUri: string }> = [];
      const blocks = parseUserMessageBlocks(`look at this [Image #1](${uri}) please`, {
        registerImage: (image) => {
          registered.push(image);
          return "/gallery/img-7";
        },
      });

      expect(registered).toHaveLength(1);
      expect(registered[0]).toMatchObject({
        mediaType: "image/png",
        data: PNG_BYTES.toString("base64"),
        sourceUri: uri,
      });
      expect(blocks).toEqual([
        { type: "text", text: "look at this " },
        { type: "text", text: "[image registered as /gallery/img-7]" },
        { type: "text", text: " please" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to inline image blocks when registerImage is absent or declines", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "user-message-"));
    try {
      const imagePath = path.join(dir, "shot.png");
      writeFileSync(imagePath, PNG_BYTES);
      const uri = pathToFileURL(imagePath).href;
      const inline = {
        type: "image" as const,
        mediaType: "image/png",
        data: PNG_BYTES.toString("base64"),
      };

      expect(parseUserMessageBlocks(`[Image #1](${uri})`)).toEqual([inline]);
      expect(parseUserMessageBlocks(`[Image #1](${uri})`, { registerImage: () => null })).toEqual([
        inline,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
