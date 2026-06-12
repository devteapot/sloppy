import { describe, expect, test } from "bun:test";

import { ImageRegistry } from "../src/core/images";

const OPTIONS = { maxLoaded: 2, defaultTtlTurns: 3, maxStored: 4 };

function jpeg(byte = 0x42): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8, byte)]);
}

function registerOne(registry: ImageRegistry, overrides: { summary?: string } = {}) {
  return registry.register({
    bytes: jpeg(),
    mediaType: "image/jpeg",
    source: "tool:demo:/camera",
    summary: overrides.summary ?? "camera frame",
    width: 800,
    height: 450,
  });
}

describe("ImageRegistry", () => {
  test("register copies bytes and auto-loads with default ttl", () => {
    const registry = new ImageRegistry(OPTIONS);
    const input = jpeg();
    const image = registry.register({
      bytes: input,
      mediaType: "image/jpeg",
      source: "user",
    });
    input.fill(0);

    expect(image.id).toBe("img-1");
    expect(image.path).toBe("/gallery/img-1");
    expect(image.loaded).toBe(true);
    expect(image.ttlTurnsRemaining).toBe(3);
    expect(image.bytes.equals(jpeg())).toBe(true);
  });

  test("onTurn decrements ttl and unloads at zero; pinned exempt", () => {
    const registry = new ImageRegistry(OPTIONS);
    const expiring = registerOne(registry);
    const pinned = registerOne(registry);
    registry.pin(pinned.id);

    registry.onTurn();
    registry.onTurn();
    expect(registry.get(expiring.id)?.ttlTurnsRemaining).toBe(1);
    registry.onTurn();

    expect(registry.get(expiring.id)?.loaded).toBe(false);
    expect(registry.get(expiring.id)?.ttlTurnsRemaining).toBeUndefined();
    expect(registry.get(pinned.id)?.loaded).toBe(true);
  });

  test("maxLoaded evicts least-recently-loaded unpinned", () => {
    const registry = new ImageRegistry(OPTIONS);
    const first = registerOne(registry);
    const second = registerOne(registry);
    const third = registerOne(registry); // maxLoaded 2 → first unloads

    expect(registry.get(first.id)?.loaded).toBe(false);
    expect(registry.get(second.id)?.loaded).toBe(true);
    expect(registry.get(third.id)?.loaded).toBe(true);
  });

  test("load fails when all attached images are pinned", () => {
    const registry = new ImageRegistry(OPTIONS);
    const a = registerOne(registry);
    const b = registerOne(registry);
    const c = registerOne(registry); // a unloaded by LRU
    registry.pin(b.id);
    registry.pin(c.id);

    expect(() => registry.load(a.id)).toThrow(/pinned/);
    expect(registry.get(a.id)?.loaded).toBe(false);
  });

  test("load reattaches an unloaded image with a custom ttl", () => {
    const registry = new ImageRegistry(OPTIONS);
    const image = registerOne(registry);
    registry.unload(image.id);

    const loaded = registry.load(image.id, { ttlTurns: 7 });
    expect(loaded.loaded).toBe(true);
    expect(loaded.ttlTurnsRemaining).toBe(7);
  });

  test("pin survives unload; reload of a pinned image carries no ttl", () => {
    const registry = new ImageRegistry(OPTIONS);
    const image = registerOne(registry);
    registry.pin(image.id);
    expect(registry.get(image.id)?.ttlTurnsRemaining).toBeUndefined();

    registry.unpin(image.id);
    expect(registry.get(image.id)?.ttlTurnsRemaining).toBe(3);

    registry.pin(image.id);
    registry.unload(image.id);
    expect(registry.get(image.id)?.pinned).toBe(true);
    expect(registry.get(image.id)?.loaded).toBe(false);

    const reloaded = registry.load(image.id);
    expect(reloaded.loaded).toBe(true);
    expect(reloaded.ttlTurnsRemaining).toBeUndefined();
  });

  test("maxStored removes oldest unpinned; pinning is capped", () => {
    const registry = new ImageRegistry(OPTIONS);
    const first = registerOne(registry);
    for (let i = 0; i < 4; i += 1) registerOne(registry);

    expect(registry.get(first.id)).toBeUndefined();
    expect(registry.list()).toHaveLength(4);

    for (const image of registry.list()) registry.pin(image.id);
    const extra = registerOne(registry); // all pinned → overflow allowed
    expect(registry.list()).toHaveLength(5);
    expect(() => registry.pin(extra.id)).toThrow(/already pinned/);
  });

  test("remove deletes; unknown ids throw", () => {
    const registry = new ImageRegistry(OPTIONS);
    const image = registerOne(registry);
    registry.remove(image.id);
    expect(registry.get(image.id)).toBeUndefined();
    expect(() => registry.unload(image.id)).toThrow(/Unknown image/);
  });

  test("collectTrailImages returns loaded images in load order with captions", () => {
    const registry = new ImageRegistry({ ...OPTIONS, maxLoaded: 3 });
    const a = registerOne(registry, { summary: "desk view" });
    const b = registerOne(registry);
    registerOne(registry); // c
    registry.load(a.id); // a becomes most recent
    registry.pin(b.id);

    const trail = registry.collectTrailImages();
    expect(trail.map((t) => t.caption)).toEqual([
      `image /gallery/${b.id} (camera frame — tool:demo:/camera, image/jpeg, 800x450, pinned):`,
      "image /gallery/img-3 (camera frame — tool:demo:/camera, image/jpeg, 800x450, ttl 3):",
      `image /gallery/${a.id} (desk view — tool:demo:/camera, image/jpeg, 800x450, ttl 3):`,
    ]);
    expect(trail[0]?.image).toEqual({
      type: "image",
      mediaType: "image/jpeg",
      data: jpeg().toString("base64"),
    });
  });

  test("setDescription validates and surfaces in captions and unloaded refs", () => {
    const registry = new ImageRegistry(OPTIONS);
    const image = registerOne(registry, { summary: "desk view" });

    expect(() => registry.setDescription(image.id, "   ")).toThrow(/empty/);
    expect(() => registry.setDescription(image.id, "x".repeat(201))).toThrow(/too long/);

    registry.setDescription(image.id, "  red mug on the desk  ");
    expect(registry.get(image.id)?.description).toBe("red mug on the desk");

    const [trail] = registry.collectTrailImages();
    expect(trail?.caption).toBe(
      `image /gallery/${image.id} (desk view — tool:demo:/camera, "red mug on the desk", image/jpeg, 800x450, ttl 3):`,
    );

    // The description survives unload — it IS the unloaded ref's meaning.
    registry.unload(image.id);
    expect(registry.get(image.id)?.description).toBe("red mug on the desk");
  });

  test("estimates tokens from dims when known, flat otherwise", () => {
    const registry = new ImageRegistry({ ...OPTIONS, maxLoaded: 3 });
    registerOne(registry); // 800x450 → ceil(360000/750) = 480
    registry.register({ bytes: jpeg(), mediaType: "image/png", source: "user" }); // flat 1100
    expect(registry.estimateLoadedImageTokens()).toBe(480 + 1100);
  });

  test("onChange fires on mutations and supports unsubscribe", () => {
    const registry = new ImageRegistry(OPTIONS);
    let calls = 0;
    const unsubscribe = registry.onChange(() => {
      calls += 1;
    });
    const image = registerOne(registry); // 1
    registry.unload(image.id); // 2
    registry.load(image.id); // 3
    registry.onTurn(); // 4 (ttl ticked)
    unsubscribe();
    registry.remove(image.id);
    expect(calls).toBe(4);
  });
});
