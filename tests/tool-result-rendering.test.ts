import { describe, expect, test } from "bun:test";
import { renderToolCallCard } from "../apps/tui/src/ui/tool-call-card";
import { renderToolContent } from "../apps/tui/src/ui/tool-renderers";
import { boundToolResult } from "../src/session/runtime";

describe("tool result capture and rendering", () => {
  test("bounds large structured tool result fields and preserves kind", () => {
    const result = boundToolResult({
      kind: "terminal",
      data: {
        command: "printf big",
        stdout: "x".repeat(6000),
      },
    });

    expect(result?.kind).toBe("terminal");
    expect(result?.truncated).toBe(true);
    expect((result?.data as { stdout: string }).stdout.length).toBeLessThan(6000);
  });

  test("renders diff and terminal result kinds", () => {
    const diff = renderToolContent(
      {
        kind: "diff",
        data: {
          path: "src/app.ts",
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [
                { kind: "remove", text: "old" },
                { kind: "add", text: "new" },
              ],
            },
          ],
        },
      },
      { verbosity: "verbose", width: 80 },
    ).join("\n");
    expect(diff).toContain("src/app.ts (+1 -1)");
    expect(diff).toContain("-old");
    expect(diff).toContain("+new");
    expect(stripAnsi(diff)).not.toContain("+new".padEnd(80));

    const terminal = renderToolContent(
      {
        kind: "terminal",
        data: {
          command: "printf hi",
          stdout: "hi",
          stderr: "",
          exitCode: 0,
          durationMs: 12,
        },
      },
      { verbosity: "verbose", width: 80 },
    ).join("\n");
    expect(terminal).toContain("$ printf hi");
    expect(terminal).toContain("stdout:");
    expect(terminal).toContain("hi");
  });

  test("renders code result kind from content without JSON escaping", () => {
    const rendered = renderToolContent(
      {
        kind: "code",
        data: {
          path: "src/app.ts",
          content: 'const title = "Hello";\nconsole.log(title);',
        },
      },
      { verbosity: "verbose", width: 80 },
    ).join("\n");

    expect(rendered).toContain("src/app.ts");
    expect(rendered).toContain('const title = "Hello";');
    expect(rendered).not.toContain("\\n");
    expect(rendered).not.toContain("```");
  });

  test("renders code compactly without file content", () => {
    const rendered = renderToolContent(
      {
        kind: "code",
        data: {
          path: "src/app.ts",
          content: "secret content",
        },
      },
      { verbosity: "compact", width: 80 },
    ).join("\n");

    expect(rendered).toContain("src/app.ts");
    expect(rendered).not.toContain("secret content");
  });

  test("omits duplicate tool summary line", () => {
    const card = renderToolCallCard(
      {
        result: {
          id: "activity-1",
          seq: 1,
          kind: "tool_result",
          status: "ok",
          summary: "filesystem:read /workspace",
          provider: "filesystem",
          path: "/workspace",
          action: "read",
          label: "Read File",
          toolUseId: "tool-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
          result: {
            kind: "code",
            data: { content: "hello" },
          },
        },
      },
      { verbosity: "verbose", width: 80 },
    );

    expect(card).toContain("Read File");
    expect(card).not.toContain("filesystem:read /workspace");
  });

  test("falls back unknown result kinds to JSON", () => {
    const rendered = renderToolContent(
      { kind: "custom", data: { ok: true } },
      { verbosity: "verbose", width: 80 },
    ).join("\n");

    expect(rendered).toContain('"ok": true');
    expect(rendered).not.toContain("```");
  });

  test("renders invocation errors from error body instead of result kind", () => {
    const card = renderToolCallCard(
      {
        result: {
          id: "activity-1",
          seq: 1,
          kind: "tool_result",
          status: "error",
          summary: "filesystem:edit /workspace",
          provider: "filesystem",
          path: "/workspace",
          action: "edit",
          toolUseId: "tool-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
          errorMessage: "Edit failed",
          result: {
            kind: "diff",
            data: { error: "no_match" },
          },
        },
      },
      { verbosity: "verbose", width: 80 },
    );

    expect(card).toContain("Edit failed");
    expect(card).toContain('"error": "no_match"');
  });
});

function stripAnsi(value: string): string {
  const sgrPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return value.replace(sgrPattern, "");
}
