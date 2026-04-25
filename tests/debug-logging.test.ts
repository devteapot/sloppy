import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { debug, isDebugEnabled, reloadDebugFromEnv } from "../src/core/debug";

const originalEnv = process.env.SLOPPY_DEBUG;
let originalWrite: typeof process.stderr.write;
let captured: string[] = [];

beforeEach(() => {
  captured = [];
  originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalWrite;
  if (originalEnv === undefined) {
    delete process.env.SLOPPY_DEBUG;
  } else {
    process.env.SLOPPY_DEBUG = originalEnv;
  }
  reloadDebugFromEnv();
});

describe("debug logger", () => {
  test("writes nothing when SLOPPY_DEBUG is unset", () => {
    delete process.env.SLOPPY_DEBUG;
    reloadDebugFromEnv();
    expect(isDebugEnabled("sub-agent")).toBe(false);
    debug("sub-agent", "noop", { id: "x" });
    expect(captured).toHaveLength(0);
  });

  test("writes JSON to stderr when scope is enabled", () => {
    process.env.SLOPPY_DEBUG = "sub-agent";
    reloadDebugFromEnv();
    expect(isDebugEnabled("sub-agent")).toBe(true);
    expect(isDebugEnabled("orchestration")).toBe(false);
    debug("sub-agent", "hello", { id: "a1" });
    debug("orchestration", "skipped", {});
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0].trim());
    expect(parsed.scope).toBe("sub-agent");
    expect(parsed.event).toBe("hello");
    expect(parsed.id).toBe("a1");
    expect(typeof parsed.ts).toBe("string");
  });

  test("SLOPPY_DEBUG=all enables every scope", () => {
    process.env.SLOPPY_DEBUG = "all";
    reloadDebugFromEnv();
    for (const scope of [
      "sub-agent",
      "orchestration",
      "filesystem",
      "delegation",
      "hub",
      "loop",
    ] as const) {
      expect(isDebugEnabled(scope)).toBe(true);
    }
  });

  test("comma-separated list enables multiple scopes", () => {
    process.env.SLOPPY_DEBUG = "sub-agent,filesystem";
    reloadDebugFromEnv();
    expect(isDebugEnabled("sub-agent")).toBe(true);
    expect(isDebugEnabled("filesystem")).toBe(true);
    expect(isDebugEnabled("orchestration")).toBe(false);
  });

  test("unknown tokens are ignored", () => {
    process.env.SLOPPY_DEBUG = "bogus,sub-agent";
    reloadDebugFromEnv();
    expect(isDebugEnabled("sub-agent")).toBe(true);
  });
});
