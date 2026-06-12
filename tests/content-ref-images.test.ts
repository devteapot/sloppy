import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { findImageContentRefs, loadContentRefImages } from "../src/core/loop/content-ref-images";

const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 0x42),
]);

let dir: string;
let jpegPath: string;
let jpegUri: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "content-ref-images-"));
  jpegPath = path.join(dir, "frame.jpg");
  writeFileSync(jpegPath, JPEG_BYTES);
  jpegUri = pathToFileURL(jpegPath).href;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function imageRef(uri: string, mime = "image/jpeg") {
  return { type: "binary", mime, summary: "a frame", uri };
}

describe("findImageContentRefs", () => {
  test("finds refs at the top level and nested", () => {
    const data = {
      ok: true,
      content_ref: imageRef("file:///a.jpg"),
      nested: { contentRef: imageRef("file:///b.png", "image/png") },
    };
    expect(findImageContentRefs(data)).toMatchObject([
      { mime: "image/jpeg", uri: "file:///a.jpg", summary: "a frame" },
      { mime: "image/png", uri: "file:///b.png", summary: "a frame" },
    ]);
  });

  test("ignores non-image mimes and non-file URIs", () => {
    const data = {
      content_ref: imageRef("file:///doc.pdf", "application/pdf"),
      other: { content_ref: imageRef("http://example.com/a.jpg") },
    };
    expect(findImageContentRefs(data)).toEqual([]);
  });

  test("caps the number of refs and the walk depth", () => {
    const many = {
      a: { content_ref: imageRef("file:///1.jpg") },
      b: { content_ref: imageRef("file:///2.jpg") },
      c: { content_ref: imageRef("file:///3.jpg") },
    };
    expect(findImageContentRefs(many, 2)).toHaveLength(2);

    const deep = { a: { b: { c: { d: { content_ref: imageRef("file:///deep.jpg") } } } } };
    expect(findImageContentRefs(deep)).toEqual([]);
  });
});

describe("loadContentRefImages", () => {
  test("loads a file:// jpeg as a base64 image block", async () => {
    const images = await loadContentRefImages(
      { ok: true, content_ref: imageRef(jpegUri) },
      { maxBytes: 5_242_880 },
    );
    expect(images).toEqual([
      { type: "image", mediaType: "image/jpeg", data: JPEG_BYTES.toString("base64") },
    ]);
  });

  test("skips files over the size cap", async () => {
    const images = await loadContentRefImages(
      { content_ref: imageRef(jpegUri) },
      { maxBytes: 16 },
    );
    expect(images).toEqual([]);
  });

  test("skips missing files and disallowed extensions", async () => {
    const missing = pathToFileURL(path.join(dir, "nope.jpg")).href;
    const badExt = path.join(dir, "frame.bin");
    writeFileSync(badExt, JPEG_BYTES);
    const images = await loadContentRefImages(
      {
        a: { content_ref: imageRef(missing) },
        b: { content_ref: imageRef(pathToFileURL(badExt).href) },
      },
      { maxBytes: 5_242_880 },
    );
    expect(images).toEqual([]);
  });
});
