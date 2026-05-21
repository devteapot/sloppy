import type { ToolCallResult } from "../backend/slop-types";
import type { Verbosity } from "../state/commands";

export type ToolRenderOptions = {
  verbosity: Verbosity;
  width: number;
};

type RenderFn = (result: ToolCallResult, options: ToolRenderOptions) => string[];

const registry: Record<"diff" | "terminal" | "text" | "json", RenderFn> = {
  diff: renderDiff,
  terminal: renderTerminal,
  text: renderText,
  json: renderJson,
};

export function renderToolContent(
  result: ToolCallResult | undefined,
  options: ToolRenderOptions,
): string[] {
  if (!result) {
    return [];
  }
  const kind = rendererKind(result);
  const lines = registry[kind](result, options);
  return result.truncated ? [...lines, "_result truncated_"] : lines;
}

function rendererKind(result: ToolCallResult): keyof typeof registry {
  if (result.kind === "diff" || result.kind === "terminal" || result.kind === "text") {
    return result.kind;
  }
  if (result.kind === "json") {
    return "json";
  }
  return typeof result.data === "string" ? "text" : "json";
}

function renderTerminal(result: ToolCallResult, options: ToolRenderOptions): string[] {
  const data = record(result.data);
  if (!data) {
    return renderJson(result, options);
  }
  const command = stringValue(data.command);
  const cwd = stringValue(data.cwd);
  const stdout = stringValue(data.stdout);
  const stderr = stringValue(data.stderr);
  const exitCode = numberValue(data.exitCode);
  const status = stringValue(data.status) ?? (exitCode === 0 ? "ok" : "error");
  const durationMs = numberValue(data.durationMs);
  const lines = [
    command ? `$ ${command}` : undefined,
    cwd && options.verbosity === "verbose" ? `cwd: ${cwd}` : undefined,
    `status: ${status}${exitCode === undefined ? "" : `, exit ${exitCode}`}${
      durationMs === undefined ? "" : `, ${durationMs}ms`
    }`,
  ].filter((line): line is string => Boolean(line));

  if (options.verbosity === "compact") {
    return lines;
  }

  if (stdout) {
    lines.push("", "stdout:", fenced(limitLines(stdout, outputLineLimit(options.verbosity))));
  }
  if (stderr) {
    lines.push("", "stderr:", fenced(limitLines(stderr, outputLineLimit(options.verbosity))));
  }
  return lines;
}

function renderDiff(result: ToolCallResult, options: ToolRenderOptions): string[] {
  const data = record(result.data);
  if (!data) {
    return renderJson(result, options);
  }
  const path = stringValue(data.path);
  const error = stringValue(data.error);
  if (error) {
    return renderJson(result, options);
  }
  const hunks = hunkArray(data.hunks) ?? hunkArray(record(data.diff)?.hunks);
  if (!hunks) {
    return renderJson(result, options);
  }
  const diffLines = hunks.flatMap((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines.map((line) =>
      line.kind === "add"
        ? `+${line.text}`
        : line.kind === "remove"
          ? `-${line.text}`
          : ` ${line.text}`,
    ),
  ]);
  const limit = options.verbosity === "compact" ? 24 : options.verbosity === "normal" ? 80 : 220;
  return [
    path ? `path: ${path}` : undefined,
    fenced(limitLineArray(diffLines, limit).join("\n")),
  ].filter((line): line is string => Boolean(line));
}

function renderText(result: ToolCallResult, options: ToolRenderOptions): string[] {
  const text =
    typeof result.data === "string" ? result.data : JSON.stringify(result.data ?? null, null, 2);
  return [limitLines(text, outputLineLimit(options.verbosity))];
}

function renderJson(result: ToolCallResult, options: ToolRenderOptions): string[] {
  const text = JSON.stringify(result.data ?? null, null, 2);
  return [fenced(limitLines(text, outputLineLimit(options.verbosity)), "json")];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type RenderHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Array<{ kind: string; text: string }>;
};

function hunkArray(value: unknown): RenderHunk[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const hunks = value.flatMap((entry): RenderHunk[] => {
    const hunk = record(entry);
    if (!hunk) {
      return [];
    }
    const lines = Array.isArray(hunk.lines)
      ? hunk.lines.flatMap((line): Array<{ kind: string; text: string }> => {
          const item = record(line);
          const kind = stringValue(item?.kind);
          const text = typeof item?.text === "string" ? item.text : undefined;
          return kind && text !== undefined ? [{ kind, text }] : [];
        })
      : [];
    if (lines.length === 0) {
      return [];
    }
    return [
      {
        oldStart: numberValue(hunk.oldStart) ?? 1,
        oldLines: numberValue(hunk.oldLines) ?? 0,
        newStart: numberValue(hunk.newStart) ?? 1,
        newLines: numberValue(hunk.newLines) ?? 0,
        lines,
      },
    ];
  });
  return hunks.length > 0 ? hunks : null;
}

function outputLineLimit(verbosity: Verbosity): number {
  return verbosity === "compact" ? 8 : verbosity === "normal" ? 40 : 160;
}

function limitLines(text: string, limit: number): string {
  return limitLineArray(text.split(/\r?\n/), limit).join("\n");
}

function limitLineArray(lines: string[], limit: number): string[] {
  if (lines.length <= limit) {
    return lines;
  }
  return [...lines.slice(0, limit), `... +${lines.length - limit} lines`];
}

function fenced(text: string, info = ""): string {
  return [`\`\`\`${info}`, text, "```"].join("\n");
}
