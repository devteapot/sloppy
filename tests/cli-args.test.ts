import { describe, expect, test } from "bun:test";

import { parseCliArgs } from "../src/cli-args";

describe("parseCliArgs", () => {
  test("parses headless -p prompts", () => {
    expect(parseCliArgs(["-p", "read", "README.md"])).toEqual({
      mode: "single",
      prompt: "read README.md",
    });
  });

  test("parses yolo approval mode without including it in prompts", () => {
    expect(parseCliArgs(["--yolo", "-p", "read", "README.md"])).toEqual({
      mode: "single",
      prompt: "read README.md",
      approvalMode: "auto",
    });
    expect(parseCliArgs(["-p", "read", "README.md", "--yolo"])).toEqual({
      mode: "single",
      prompt: "read README.md",
      approvalMode: "auto",
    });
  });

  test("parses long prompt flags", () => {
    expect(parseCliArgs(["--prompt=hello world"])).toEqual({
      mode: "single",
      prompt: "hello world",
    });
    expect(parseCliArgs(["--prompt", "hello", "again"])).toEqual({
      mode: "single",
      prompt: "hello again",
    });
  });

  test("keeps bare prompt compatibility", () => {
    expect(parseCliArgs(["list", "files"])).toEqual({
      mode: "single",
      prompt: "list files",
    });
  });

  test("handles repl, help, and missing prompt cases", () => {
    expect(parseCliArgs([])).toEqual({ mode: "repl" });
    expect(parseCliArgs(["--help"])).toEqual({ mode: "help" });
    expect(parseCliArgs(["-p"])).toEqual({
      mode: "error",
      message: "-p requires a prompt.",
    });
  });
});
