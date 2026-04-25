import { describe, expect, test } from "bun:test";

import { buildToolName } from "../src/core/tools";

describe("buildToolName", () => {
  test("short name passes through unchanged", () => {
    expect(buildToolName("fs", "read")).toBe("fs__read");
  });

  test("name exactly at the limit passes through unchanged", () => {
    const provider = "p".repeat(10);
    const tool = "t".repeat(64 - 10 - 2);
    const name = buildToolName(provider, tool);
    expect(name.length).toBe(64);
    expect(name).toBe(`${provider}__${tool}`);
  });

  test("name 1 char over the limit gets hash-truncated to exactly the limit", () => {
    const provider = "p".repeat(10);
    const tool = "t".repeat(64 - 10 - 2 + 1);
    const name = buildToolName(provider, tool);
    expect(name.length).toBe(64);
    expect(name).toMatch(/_[0-9a-f]{7}$/);
  });

  test("UUID-style provider + tool produces ≤ limit name", () => {
    const provider = "550e8400-e29b-41d4-a716-446655440001".replaceAll("-", "_");
    const tool = "550e8400-e29b-41d4-a716-446655440000__edit".replaceAll("-", "_");
    const name = buildToolName(provider, tool);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/_[0-9a-f]{7}$/);
  });

  test("two distinct overlong names produce distinct truncated names", () => {
    const long = "x".repeat(80);
    const a = buildToolName("provider", `${long}_a`);
    const b = buildToolName("provider", `${long}_b`);
    expect(a).not.toBe(b);
    expect(a.length).toBe(64);
    expect(b.length).toBe(64);
  });

  test("hashing is deterministic across calls", () => {
    const long = "x".repeat(80);
    expect(buildToolName("p", long)).toBe(buildToolName("p", long));
  });

  test("custom limit is honored", () => {
    expect(buildToolName("p", "tool", 32).length).toBeLessThanOrEqual(32);
    const overlong = buildToolName("p", "x".repeat(80), 32);
    expect(overlong.length).toBe(32);
    expect(overlong).toMatch(/_[0-9a-f]{7}$/);
  });
});
