import type { ToolCallResult } from "../backend/slop-types";
import type { Verbosity } from "../state/commands";
import { sanitizeTerminalText } from "./render-safety";
import { bgAdd, bgRemove, bold, dim, red } from "./theme";

export type ToolRenderOptions = {
  verbosity: Verbosity;
  width: number;
};

type RenderFn = (result: ToolCallResult, options: ToolRenderOptions) => string[];

const registry: Record<"code" | "diff" | "terminal" | "text" | "json", RenderFn> = {
  code: renderCode,
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
  return result.truncated ? [...lines, dim("(result truncated)")] : lines;
}

function rendererKind(result: ToolCallResult): keyof typeof registry {
  if (
    result.kind === "code" ||
    result.kind === "diff" ||
    result.kind === "terminal" ||
    result.kind === "text"
  ) {
    return result.kind;
  }
  if (result.kind === "json") {
    return "json";
  }
  return typeof result.data === "string" ? "text" : "json";
}

function renderCode(result: ToolCallResult, options: ToolRenderOptions): string[] {
  const data = record(result.data);
  if (!data) {
    return renderText(result, options);
  }
  const label = fileLabel(data);
  const content = stringValue(data.content) ?? stringValue(data.text);
  if (options.verbosity === "compact") {
    return [dim(label ?? "file content omitted")];
  }
  if (!content) {
    return label ? [dim(label)] : renderJson(result, options);
  }
  return [dim(label ?? "file content"), limitLines(content, outputLineLimit(options.verbosity))];
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
  const statusText = `status: ${status}${exitCode === undefined ? "" : `, exit ${exitCode}`}${
    durationMs === undefined ? "" : `, ${durationMs}ms`
  }`;
  const failed = status === "error" || (exitCode !== undefined && exitCode !== 0);
  const lines = [
    command ? bold(`$ ${command}`) : undefined,
    cwd && options.verbosity === "verbose" ? dim(`cwd: ${cwd}`) : undefined,
    failed ? red(statusText) : dim(statusText),
  ].filter((line): line is string => Boolean(line));

  if (options.verbosity === "compact") {
    return lines;
  }

  if (stdout) {
    lines.push("", dim("stdout:"), limitLines(stdout, outputLineLimit(options.verbosity)));
  }
  if (stderr) {
    lines.push("", dim("stderr:"), limitLines(stderr, outputLineLimit(options.verbosity)));
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
  let added = 0;
  let removed = 0;
  const diffLines = hunks.flatMap((hunk) =>
    hunk.lines.map((line) => {
      if (line.kind === "add") {
        added += 1;
        return tintLine(`+${line.text}`, bgAdd);
      }
      if (line.kind === "remove") {
        removed += 1;
        return tintLine(`-${line.text}`, bgRemove);
      }
      return ` ${line.text}`;
    }),
  );
  const limit = options.verbosity === "compact" ? 24 : 220;
  const header = dim([path, `(+${added} -${removed})`].filter(Boolean).join(" "));
  return [header, ...limitLineArray(diffLines, limit)];
}

function renderText(result: ToolCallResult, options: ToolRenderOptions): string[] {
  const text = sanitizeTerminalText(
    typeof result.data === "string" ? result.data : JSON.stringify(result.data ?? null, null, 2),
  );
  return [limitLines(text, outputLineLimit(options.verbosity))];
}

function renderJson(result: ToolCallResult, options: ToolRenderOptions): string[] {
  const data = record(result.data);
  if (data && options.verbosity === "compact") {
    const structured = renderStructuredData(data);
    if (structured) {
      return [dim(structured)];
    }
  }
  const text = sanitizeTerminalText(JSON.stringify(result.data ?? null, null, 2));
  return [limitLines(text, outputLineLimit(options.verbosity))];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const sanitized = sanitizeTerminalText(value);
  return sanitized.length > 0 ? sanitized : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function lineRangeLabel(data: Record<string, unknown>): string | undefined {
  const startLine = numberValue(data.startLine) ?? numberValue(data.start_line);
  const endLine = numberValue(data.endLine) ?? numberValue(data.end_line);
  if (startLine === undefined || endLine === undefined) {
    return undefined;
  }
  return startLine === endLine ? String(startLine) : `${startLine}-${endLine}`;
}

function fileLabel(data: Record<string, unknown>): string | undefined {
  const path = stringValue(data.path);
  const totalLines = numberValue(data.totalLines) ?? numberValue(data.total_lines);
  const lineRange = lineRangeLabel(data);
  const details = [totalLines, lineRange].filter((value) => value !== undefined);
  if (!path) {
    return details.length > 0 ? `(${details.join("; ")})` : undefined;
  }
  return details.length > 0 ? `${path} (${details.join("; ")})` : path;
}

function renderStructuredData(data: Record<string, unknown>): string | undefined {
  const search = searchLabel(data);
  if (search) {
    return search;
  }
  const written = writeLabel(data);
  if (written) {
    return written;
  }
  return fileLabel(data);
}

function searchLabel(data: Record<string, unknown>): string | undefined {
  const pattern = stringValue(data.pattern);
  const resultCount = numberValue(data.resultCount) ?? numberValue(data.result_count);
  if (!pattern && resultCount === undefined) {
    return undefined;
  }
  const basePath = stringValue(data.basePath) ?? stringValue(data.path);
  const where = basePath ? ` in ${basePath}` : "";
  const count = resultCount === undefined ? "results" : plural(resultCount, "result");
  return pattern ? `“${pattern}”${where} (${count})` : `${basePath ?? "search"} (${count})`;
}

function writeLabel(data: Record<string, unknown>): string | undefined {
  const path = stringValue(data.path);
  const bytes = numberValue(data.bytes);
  const version = numberValue(data.version);
  const edits = numberValue(data.edits_applied);
  const oldBytes = numberValue(data.old_bytes);
  const newBytes = numberValue(data.new_bytes);
  if (!path || (bytes === undefined && version === undefined && edits === undefined)) {
    return undefined;
  }
  const detail =
    edits !== undefined
      ? `${plural(edits, "edit")}${oldBytes !== undefined && newBytes !== undefined ? `; ${formatBytes(oldBytes)}→${formatBytes(newBytes)}` : ""}`
      : bytes !== undefined
        ? formatBytes(bytes)
        : version !== undefined
          ? `v${version}`
          : undefined;
  return detail ? `${path} (${detail})` : path;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) {
    return `${formatCompact(bytes / 1_000_000)}MB`;
  }
  if (bytes >= 1_000) {
    return `${formatCompact(bytes / 1_000)}KB`;
  }
  return `${bytes}B`;
}

function formatCompact(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
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
          const text = typeof item?.text === "string" ? sanitizeTerminalText(item.text) : undefined;
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
  return verbosity === "compact" ? 8 : 160;
}

function tintLine(text: string, paint: (value: string) => string): string {
  return paint(text);
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
