import { describe, expect, test } from "bun:test";

import { truncateToolResult } from "../src/core/loop";

describe("truncateToolResult", () => {
  test("does not modify results under the limit", () => {
    const result = "Hello, world!";
    const output = truncateToolResult(result, 4096);
    expect(output).toBe("Hello, world!");
    expect(output.length).toBeLessThanOrEqual(4096);
  });

  test("truncates and appends message when over limit", () => {
    const largeResult = "A".repeat(10000);
    const output = truncateToolResult(largeResult, 4096);
    expect(output.length).toBeLessThanOrEqual(4096);
    expect(output).toContain("truncated");
    expect(output).toContain("chars removed");
    expect(output).toContain("slop_query_state");
    expect(output).toContain("full details]");
  });

  test("ensures total output does not exceed limit", () => {
    const largeResult = "B".repeat(20000);
    const output = truncateToolResult(largeResult, 1000);
    expect(output.length).toBeLessThanOrEqual(1000);
  });

  test("handles empty results", () => {
    const empty = "";
    const output = truncateToolResult(empty, 4096);
    expect(output).toBe("");
    expect(output.length).toBe(0);
  });
});
