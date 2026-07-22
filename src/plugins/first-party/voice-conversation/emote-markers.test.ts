import { describe, expect, test } from "bun:test";

import { hasEmoteMarkers, parseEmoteMarkers } from "./emote-markers";

const NAMES = ["cheerful1", "curious1", "fear1"];

describe("hasEmoteMarkers", () => {
  test("detects markers anywhere in the text", () => {
    expect(hasEmoteMarkers("plain reply")).toBe(false);
    expect(hasEmoteMarkers("hi [emote:cheerful1] there")).toBe(true);
    expect(hasEmoteMarkers("[ Emote : Fear1 ]")).toBe(true);
  });

  test("is stateless across calls (global regex reset)", () => {
    const text = "[emote:fear1]";
    expect(hasEmoteMarkers(text)).toBe(true);
    expect(hasEmoteMarkers(text)).toBe(true);
  });
});

describe("parseEmoteMarkers", () => {
  test("no markers: one segment with the original text", () => {
    expect(parseEmoteMarkers("Just a reply.", NAMES)).toEqual([{ text: "Just a reply." }]);
  });

  test("mid-reply marker splits into two segments", () => {
    expect(parseEmoteMarkers("Bad news. [emote:fear1] But it's fine!", NAMES)).toEqual([
      { text: "Bad news." },
      { emotion: "fear1", text: "But it's fine!" },
    ]);
  });

  test("marker at position 0 drops the empty leading segment", () => {
    expect(parseEmoteMarkers("[emote:cheerful1] Hello!", NAMES)).toEqual([
      { emotion: "cheerful1", text: "Hello!" },
    ]);
  });

  test("marker at the end yields an empty-text emotion segment", () => {
    expect(parseEmoteMarkers("Goodbye. [emote:fear1]", NAMES)).toEqual([
      { text: "Goodbye." },
      { emotion: "fear1", text: "" },
    ]);
  });

  test("consecutive markers yield an empty-text segment in between", () => {
    expect(parseEmoteMarkers("Wow [emote:fear1][emote:cheerful1] ok", NAMES)).toEqual([
      { text: "Wow" },
      { emotion: "fear1", text: "" },
      { emotion: "cheerful1", text: "ok" },
    ]);
  });

  test("unknown name is stripped without splitting", () => {
    expect(parseEmoteMarkers("Hello [emote:bogus] world.", NAMES)).toEqual([
      { text: "Hello world." },
    ]);
  });

  test("null vocabulary keeps unknown names (provider validates)", () => {
    expect(parseEmoteMarkers("Hello [emote:bogus] world.", null)).toEqual([
      { text: "Hello" },
      { emotion: "bogus", text: "world." },
    ]);
  });

  test("tolerates case and internal whitespace", () => {
    expect(parseEmoteMarkers("a [ Emote : Cheerful1 ] b", NAMES)).toEqual([
      { text: "a" },
      { emotion: "cheerful1", text: "b" },
    ]);
  });

  test("empty name is stripped and never spoken", () => {
    expect(parseEmoteMarkers("a [emote:] b", NAMES)).toEqual([{ text: "a b" }]);
  });

  test("markers-only reply keeps only emotion segments", () => {
    expect(parseEmoteMarkers("[emote:fear1]", NAMES)).toEqual([{ emotion: "fear1", text: "" }]);
  });

  test("whitespace around stripped markers collapses", () => {
    expect(parseEmoteMarkers("left  [emote:bogus]  right", NAMES)).toEqual([
      { text: "left right" },
    ]);
  });
});
