import { describe, expect, test } from "bun:test";

import { formatHomePath } from "../apps/tui/src/ui/display-path";

describe("formatHomePath", () => {
  test("replaces the current home directory prefix with tilde", () => {
    expect(formatHomePath("/Users/alice/dev/sloppy", "/Users/alice")).toBe("~/dev/sloppy");
  });

  test("replaces the exact home directory with tilde", () => {
    expect(formatHomePath("/Users/alice", "/Users/alice")).toBe("~");
    expect(formatHomePath("/Users/alice/", "/Users/alice")).toBe("~");
  });

  test("does not rewrite other users or similar prefixes", () => {
    expect(formatHomePath("/Users/bob/dev/sloppy", "/Users/alice")).toBe("/Users/bob/dev/sloppy");
    expect(formatHomePath("/Users/alice-other/dev/sloppy", "/Users/alice")).toBe(
      "/Users/alice-other/dev/sloppy",
    );
  });
});
