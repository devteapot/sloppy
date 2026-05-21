import { describe, expect, test } from "bun:test";

import {
  prepareFinalAssistantMarkdown,
  prepareTolerantAssistantMarkdown,
  splitMarkdownRenderUnits,
} from "../apps/tui/src/ui/markdown-normalization";
import { escapeMarkdownText, sanitizeTerminalText } from "../apps/tui/src/ui/render-safety";
import { SafeMarkdown, StreamingMarkdown } from "../apps/tui/src/ui/streaming-markdown";

function stripAnsi(value: string): string {
  const sgrPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return value.replace(sgrPattern, "");
}

describe("TUI markdown rendering helpers", () => {
  test("strips terminal control sequences from untrusted text", () => {
    const input = [
      "hello",
      "\x1b[2J",
      "\x1b]8;;https://example.test\x07link\x1b]8;;\x07",
      "\x07",
      "world",
    ].join("");

    const sanitized = sanitizeTerminalText(input);

    expect(sanitized).toBe("hellolinkworld");
    expect(sanitized).not.toContain("\x1b");
    expect(sanitized).not.toContain("\x07");
  });

  test("escapes markdown metacharacters for operational UI fields", () => {
    expect(escapeMarkdownText("# **x** | [docs](url)")).toBe(
      "\\# \\*\\*x\\*\\* \\| \\[docs\\]\\(url\\)",
    );
  });

  test("adds synthetic code fence closers only for tolerant rendering", () => {
    const prepared = prepareTolerantAssistantMarkdown("```ts\nconst x = 1;");

    expect(prepared).toBe("```ts\nconst x = 1;\n```");
  });

  test("splits streaming markdown only at conservative render-unit boundaries", () => {
    expect(splitMarkdownRenderUnits("paragraph\n\nnext")).toEqual({
      stableUnits: ["paragraph\n\n"],
      tailSource: "next",
    });
    expect(splitMarkdownRenderUnits("# Heading\nbody")).toEqual({
      stableUnits: ["# Heading\n"],
      tailSource: "body",
    });
    expect(splitMarkdownRenderUnits("line one\nline two\n")).toEqual({
      stableUnits: [],
      tailSource: "line one\nline two\n",
    });
  });

  test("keeps tables and reference-link documents mutable while streaming", () => {
    const table = "| a | b |\n| - | - |\n| 1 | 2 |\n";
    expect(splitMarkdownRenderUnits(table)).toEqual({ stableUnits: [], tailSource: table });
    expect(splitMarkdownRenderUnits(`${table}\nnext`)).toEqual({
      stableUnits: [`${table}\n`],
      tailSource: "next",
    });

    const reference = "See [docs][docs].\n\n[docs]: https://example.test\n";
    expect(splitMarkdownRenderUnits(reference)).toEqual({
      stableUnits: [],
      tailSource: reference,
    });
  });

  test("unwraps only complete markdown fences that contain tables", () => {
    const tableFence = ["```markdown", "| a | b |", "| - | - |", "| 1 | 2 |", "```"].join("\n");
    const nonTableFence = ["```markdown", "**literal**", "```"].join("\n");

    expect(prepareFinalAssistantMarkdown(tableFence)).toBe("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(prepareFinalAssistantMarkdown(nonTableFence)).toBe(nonTableFence);
  });

  test("renders streaming open code fences without literal fence markers", () => {
    const markdown = new StreamingMarkdown("```ts\nconst x = 1;", 1, 1);
    const rendered = stripAnsi(markdown.render(80).join("\n"));

    expect(rendered).toContain("const x = 1;");
    expect(rendered).not.toContain("```ts");
  });

  test("renders errored partial markdown with tolerant full rendering", () => {
    const markdown = new SafeMarkdown("```ts\nconst x = 1;", "tolerant", 1, 1);
    const rendered = stripAnsi(markdown.render(80).join("\n"));

    expect(rendered).toContain("const x = 1;");
    expect(rendered).not.toContain("```ts");
  });
});
