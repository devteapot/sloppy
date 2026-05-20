#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

type BenchmarkRun = {
  caseId: string;
  mode: string;
  success: boolean;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  modelCalls?: number;
  toolCalls?: number;
  artifactPath?: string;
  editActions?: string[];
};

type BenchmarkOutput = {
  runs: BenchmarkRun[];
  artifactDir?: string;
};

type ToolRecord = {
  name: string;
  action: string;
  kind: string;
  path?: string;
  params: Record<string, unknown>;
};

function usage(): string {
  return [
    "Usage: bun run benchmark:headless-edit-modes:analyze -- <artifact-dir>",
    "",
    "Reads a headless edit-mode benchmark artifact directory and summarizes",
    "per-case tool sequences, token usage, tagged reads, and edit payload sizes.",
  ].join("\n");
}

function parseToolLine(line: string): ToolRecord | null {
  const match = line.match(/^\[tool\]\s+([^\s]+)\s+(.*)$/);
  if (!match?.[1]) {
    return null;
  }

  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(match[2] ?? "{}") as Record<string, unknown>;
  } catch {
    params = {};
  }
  const action = match[1].split("__").at(-1) ?? match[1];
  const kind =
    action === "read"
      ? params.include_line_tags
        ? `read:tags:${typeof params.tag_mode === "string" ? params.tag_mode : "all"}`
        : typeof params.start_line === "number" || typeof params.end_line === "number"
          ? "read:range"
          : "read:full"
      : action;

  return {
    name: match[1],
    action,
    kind,
    path: typeof params.path === "string" ? params.path : undefined,
    params,
  };
}

function parseStdoutTools(artifactPath: string): ToolRecord[] {
  const stdoutPath = join(artifactPath, "stdout.txt");
  if (!existsSync(stdoutPath)) {
    return [];
  }
  return readFileSync(stdoutPath, "utf8")
    .split("\n")
    .map(parseToolLine)
    .filter((record): record is ToolRecord => record !== null);
}

function countEventLines(artifactPath: string): number | undefined {
  const eventsPath = join(artifactPath, "events.jsonl");
  if (!existsSync(eventsPath)) {
    return undefined;
  }
  return readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean).length;
}

function editPayloadChars(tools: ToolRecord[]): number {
  return tools
    .filter((tool) => tool.action === "edit" || tool.action === "edit_range")
    .reduce((sum, tool) => sum + JSON.stringify(tool.params).length, 0);
}

function readKinds(tools: ToolRecord[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    if (tool.action !== "read") {
      continue;
    }
    counts.set(tool.kind, (counts.get(tool.kind) ?? 0) + 1);
  }
  return [...counts.entries()].map(([kind, count]) => `${kind}=${count}`).join(" ") || "-";
}

function loadBenchmark(root: string): BenchmarkOutput {
  const benchmarkPath = join(root, "benchmark.json");
  if (existsSync(benchmarkPath)) {
    return JSON.parse(readFileSync(benchmarkPath, "utf8")) as BenchmarkOutput;
  }

  const runs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const summaryPath = join(root, entry.name, "summary.json");
      return existsSync(summaryPath)
        ? [JSON.parse(readFileSync(summaryPath, "utf8")) as BenchmarkRun]
        : [];
    });
  return { runs, artifactDir: root };
}

function pct(delta: number): string {
  return `${delta >= 0 ? "+" : ""}${Math.round(delta * 10) / 10}%`;
}

const arg = Bun.argv.find((value, index) => index > 1 && value !== "--");
if (!arg || arg === "-h" || arg === "--help") {
  console.log(usage());
  process.exit(arg ? 0 : 1);
}

const root = resolve(arg);
const benchmark = loadBenchmark(root);
const rows = benchmark.runs.map((run) => {
  const artifactPath = run.artifactPath ?? join(root, `01-${run.caseId}-${run.mode}`);
  const tools = parseStdoutTools(artifactPath);
  return {
    case: run.caseId,
    mode: run.mode,
    ok: run.success,
    elapsedMs: run.elapsedMs,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    modelCalls: run.modelCalls,
    toolCalls: run.toolCalls,
    taggedReads: tools.filter((tool) => tool.kind.startsWith("read:tags")).length,
    editPayloadChars: editPayloadChars(tools),
    events: countEventLines(artifactPath),
    reads: readKinds(tools),
    edits: run.editActions?.join(",") || "-",
    sequence: tools.map((tool) => tool.kind).join(" -> "),
  };
});

console.log(`Headless edit-mode artifact analysis: ${root}`);
console.table(
  rows.map(({ sequence: _sequence, ...row }) => ({
    ...row,
    reads: row.reads.length > 80 ? `${row.reads.slice(0, 77)}...` : row.reads,
  })),
);

const byKey = new Map(rows.map((row) => [`${row.case}/${row.mode}`, row]));
const deltas = [...new Set(rows.map((row) => row.case))]
  .sort()
  .flatMap((caseId) => {
    const replace = byKey.get(`${caseId}/replace`);
    const hash = byKey.get(`${caseId}/hash`);
    if (!replace || !hash || !replace.inputTokens || !hash.inputTokens) {
      return [];
    }
    return [
      {
        case: caseId,
        hashInputDelta: `${hash.inputTokens - replace.inputTokens} (${pct(
          (hash.inputTokens / replace.inputTokens - 1) * 100,
        )})`,
        hashOutputDelta:
          replace.outputTokens && hash.outputTokens
            ? `${hash.outputTokens - replace.outputTokens} (${pct(
                (hash.outputTokens / replace.outputTokens - 1) * 100,
              )})`
            : "n/a",
        hashModelCallsDelta: (hash.modelCalls ?? 0) - (replace.modelCalls ?? 0),
        hashToolCallsDelta: (hash.toolCalls ?? 0) - (replace.toolCalls ?? 0),
        hashTaggedReadsDelta: hash.taggedReads - replace.taggedReads,
        hashEditPayloadDelta: hash.editPayloadChars - replace.editPayloadChars,
      },
    ];
  });

if (deltas.length > 0) {
  console.log("");
  console.log("Hash vs replace deltas:");
  console.table(deltas);
}

console.log("");
console.log("Tool sequences:");
for (const row of rows) {
  console.log(`${row.case}/${row.mode}: ${row.sequence || "-"}`);
}
