import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { FilesystemProvider } from "../src/plugins/first-party/filesystem/provider";
import { InProcessTransport } from "../src/providers/in-process";

type LineRange = {
  start: number;
  end: number;
};

type BenchmarkCase = {
  name: string;
  description: string;
  path: string;
  before: string;
  readRange: LineRange;
  editRange: LineRange;
  legacyOldText: string;
  legacyNewText: string;
  sourceNewText: string;
};

type DriftCase = BenchmarkCase & {
  drift: (content: string) => string;
};

type InvokeResult = {
  status?: string;
  data?: unknown;
  error?: unknown;
};

type IterationMetrics = {
  elapsedMs: number;
  readArgsBytes: number;
  readResultBytes: number;
  editArgsBytes: number;
  editResultBytes: number;
  totalBytes: number;
  status: string;
};

type ApproachSummary = {
  status: string;
  readArgsBytes: number;
  readResultBytes: number;
  editArgsBytes: number;
  editResultBytes: number;
  totalBytes: number;
  tokenProxy: number;
  p50Ms: number;
  p95Ms: number;
};

type BenchmarkRow = {
  case: string;
  legacyStatus: string;
  sourceStatus: string;
  legacyTotalBytes: number;
  sourceTotalBytes: number;
  legacyTokenProxy: number;
  sourceTokenProxy: number;
  sourceSavedPercent: number;
  legacyEditBytes: number;
  sourceEditBytes: number;
  sourceEditSavedPercent: number;
  legacyP50Ms: number;
  sourceP50Ms: number;
  legacyP95Ms: number;
  sourceP95Ms: number;
  description: string;
};

type DriftRow = {
  case: string;
  legacyStatus: string;
  sourceStatus: string;
  legacyFinal: string;
  sourceFinal: string;
  description: string;
};

type BenchmarkOutput = {
  rows: BenchmarkRow[];
  drift: DriftRow;
};

type CliOptions = {
  iterations: number;
  json: boolean;
  help: boolean;
};

function parseCliOptions(argv: string[]): CliOptions {
  const args = argv.filter((arg) => arg !== "--");
  let iterations = 25;
  let json = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--iterations" || arg === "-n") {
      const next = args[index + 1];
      const parsed = Number.parseInt(next ?? "", 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--iterations must be a positive integer.");
      }
      iterations = parsed;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { iterations, json, help };
}

function usage(): string {
  return [
    "Usage: bun run benchmark:filesystem-view-edits -- [--iterations N] [--json]",
    "",
    "Compares legacy exact-text edit payloads with source-view edit_range payloads.",
  ].join("\n");
}

function byteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized ?? "undefined", "utf8");
}

function statusOf(result: InvokeResult): string {
  const data = result.data;
  if (data && typeof data === "object" && "error" in data) {
    const error = (data as { error?: unknown }).error;
    if (typeof error === "string") {
      return error;
    }
  }
  if (typeof result.status === "string") {
    return result.status;
  }
  return "unknown";
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index] ?? 0;
}

function round(value: number, places = 2): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function savedPercent(legacy: number, source: number): number {
  if (legacy === 0) {
    return 0;
  }
  return round((1 - source / legacy) * 100, 1);
}

function summarize(iterations: IterationMetrics[]): ApproachSummary {
  const first = iterations[0];
  if (!first) {
    throw new Error("Cannot summarize an empty benchmark run.");
  }
  return {
    status: first.status,
    readArgsBytes: first.readArgsBytes,
    readResultBytes: first.readResultBytes,
    editArgsBytes: first.editArgsBytes,
    editResultBytes: first.editResultBytes,
    totalBytes: first.totalBytes,
    tokenProxy: Math.ceil(first.totalBytes / 4),
    p50Ms: round(percentile(iterations.map((entry) => entry.elapsedMs), 0.5)),
    p95Ms: round(percentile(iterations.map((entry) => entry.elapsedMs), 0.95)),
  };
}

async function writeFixture(root: string, path: string, content: string): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

async function createProvider(root: string): Promise<{
  provider: FilesystemProvider;
  consumer: SlopConsumer;
}> {
  const provider = new FilesystemProvider({
    root,
    focus: root,
    recentLimit: 10,
    searchLimit: 20,
    readMaxBytes: 65536,
  });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));
  await consumer.connect();
  await consumer.subscribe("/", 3);
  return { provider, consumer };
}

async function runLegacyIteration(benchmark: BenchmarkCase): Promise<IterationMetrics> {
  const root = await mkdtemp(join(tmpdir(), "sloppy-fs-view-bench-legacy-"));
  await writeFixture(root, benchmark.path, benchmark.before);
  const { provider, consumer } = await createProvider(root);

  try {
    const started = performance.now();
    const readArgs = {
      path: benchmark.path,
      start_line: benchmark.readRange.start,
      end_line: benchmark.readRange.end,
    };
    const readResult = await consumer.invoke("/workspace", "read", readArgs);
    const editArgs = {
      path: benchmark.path,
      edits: [
        {
          oldText: benchmark.legacyOldText,
          newText: benchmark.legacyNewText,
        },
      ],
    };
    const editResult = await consumer.invoke("/workspace", "edit", editArgs);

    return {
      elapsedMs: performance.now() - started,
      readArgsBytes: byteLength(readArgs),
      readResultBytes: byteLength(readResult.data),
      editArgsBytes: byteLength(editArgs),
      editResultBytes: byteLength(editResult.data),
      totalBytes:
        byteLength(readArgs) +
        byteLength(readResult.data) +
        byteLength(editArgs) +
        byteLength(editResult.data),
      status: statusOf(editResult),
    };
  } finally {
    provider.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function runSourceIteration(benchmark: BenchmarkCase): Promise<IterationMetrics> {
  const root = await mkdtemp(join(tmpdir(), "sloppy-fs-view-bench-source-"));
  await writeFixture(root, benchmark.path, benchmark.before);
  const { provider, consumer } = await createProvider(root);

  try {
    const started = performance.now();
    const readArgs = {
      path: benchmark.path,
      start_line: benchmark.readRange.start,
      end_line: benchmark.readRange.end,
    };
    const readResult = await consumer.invoke("/workspace", "read", readArgs);
    const sourceVersion = (readResult.data as { source_version?: number }).source_version;
    const editArgs = {
      path: benchmark.path,
      source_version: sourceVersion,
      edits: [
        {
          start_line: benchmark.editRange.start,
          end_line: benchmark.editRange.end,
          new_text: benchmark.sourceNewText,
        },
      ],
    };
    const editResult = await consumer.invoke("/workspace", "edit_range", editArgs);

    return {
      elapsedMs: performance.now() - started,
      readArgsBytes: byteLength(readArgs),
      readResultBytes: byteLength(readResult.data),
      editArgsBytes: byteLength(editArgs),
      editResultBytes: byteLength(editResult.data),
      totalBytes:
        byteLength(readArgs) +
        byteLength(readResult.data) +
        byteLength(editArgs) +
        byteLength(editResult.data),
      status: statusOf(editResult),
    };
  } finally {
    provider.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function readContent(consumer: SlopConsumer, path: string): Promise<string> {
  const result = await consumer.invoke("/workspace", "read", { path });
  return (result.data as { content: string }).content;
}

async function runDriftCase(benchmark: DriftCase): Promise<DriftRow> {
  const legacyRoot = await mkdtemp(join(tmpdir(), "sloppy-fs-view-bench-drift-legacy-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "sloppy-fs-view-bench-drift-source-"));
  await writeFixture(legacyRoot, benchmark.path, benchmark.before);
  await writeFixture(sourceRoot, benchmark.path, benchmark.before);

  const legacy = await createProvider(legacyRoot);
  const source = await createProvider(sourceRoot);

  try {
    const readArgs = {
      path: benchmark.path,
      start_line: benchmark.readRange.start,
      end_line: benchmark.readRange.end,
    };
    await legacy.consumer.invoke("/workspace", "read", readArgs);
    const sourceRead = await source.consumer.invoke("/workspace", "read", readArgs);
    const sourceVersion = (sourceRead.data as { source_version?: number }).source_version;

    await writeFixture(legacyRoot, benchmark.path, benchmark.drift(benchmark.before));
    await writeFixture(sourceRoot, benchmark.path, benchmark.drift(benchmark.before));

    const legacyResult = await legacy.consumer.invoke("/workspace", "edit", {
      path: benchmark.path,
      edits: [{ oldText: benchmark.legacyOldText, newText: benchmark.legacyNewText }],
    });
    const sourceResult = await source.consumer.invoke("/workspace", "edit_range", {
      path: benchmark.path,
      source_version: sourceVersion,
      edits: [
        {
          start_line: benchmark.editRange.start,
          end_line: benchmark.editRange.end,
          new_text: benchmark.sourceNewText,
        },
      ],
    });

    return {
      case: benchmark.name,
      legacyStatus: statusOf(legacyResult),
      sourceStatus: statusOf(sourceResult),
      legacyFinal: await readContent(legacy.consumer, benchmark.path),
      sourceFinal: await readContent(source.consumer, benchmark.path),
      description: benchmark.description,
    };
  } finally {
    legacy.provider.stop();
    source.provider.stop();
    await rm(legacyRoot, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
}

function blockLines(prefix: string, count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `  ${prefix}_${String(index + 1).padStart(3, "0")}: process(item, ${index + 1});`,
  ).join("\n");
}

function numberedList(prefix: string, count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `- ${prefix} ${String(index + 1).padStart(2, "0")}: keep operational detail`,
  ).join("\n");
}

const largeOldBlock = blockLines("legacy_step", 80);
const largeNewBlock = [
  "  summary: processBatch(item);",
  "  metrics: collectBatchMetrics(item);",
  "  return finalizeBatch(item);",
].join("\n");

const docOldBlock = numberedList("checkpoint", 18);
const docNewBlock = [
  "- checkpoint summary: validate inputs, runtime state, and final output",
  "- checkpoint owner: runtime operator",
  "- checkpoint cadence: every release candidate",
].join("\n");

const CASES: BenchmarkCase[] = [
  {
    name: "tiny-line",
    description: "One short unique line change.",
    path: "src/config.ts",
    before: ['export const config = {', '  mode: "dev",', "  retries: 2,", "};"].join("\n"),
    readRange: { start: 1, end: 4 },
    editRange: { start: 2, end: 2 },
    legacyOldText: '  mode: "dev",',
    legacyNewText: '  mode: "prod",',
    sourceNewText: '  mode: "prod",',
  },
  {
    name: "repeated-region",
    description: "One repeated line where legacy edit needs surrounding context.",
    path: "runbook.md",
    before: [
      "## alpha",
      "status: pending",
      "owner: team-a",
      "done",
      "",
      "## beta",
      "status: pending",
      "owner: team-b",
      "done",
    ].join("\n"),
    readRange: { start: 6, end: 8 },
    editRange: { start: 7, end: 7 },
    legacyOldText: ["## beta", "status: pending", "owner: team-b"].join("\n"),
    legacyNewText: ["## beta", "status: done", "owner: team-b"].join("\n"),
    sourceNewText: "status: done",
  },
  {
    name: "large-block",
    description: "Large generated block replacement where oldText echo dominates.",
    path: "src/pipeline.ts",
    before: ["export function runPipeline(item) {", largeOldBlock, "}"].join("\n"),
    readRange: { start: 2, end: 81 },
    editRange: { start: 2, end: 81 },
    legacyOldText: largeOldBlock,
    legacyNewText: largeNewBlock,
    sourceNewText: largeNewBlock,
  },
  {
    name: "doc-block",
    description: "Medium documentation block rewrite.",
    path: "docs/checklist.md",
    before: ["# Checklist", "", docOldBlock, "", "End."].join("\n"),
    readRange: { start: 3, end: 20 },
    editRange: { start: 3, end: 20 },
    legacyOldText: docOldBlock,
    legacyNewText: docNewBlock,
    sourceNewText: docNewBlock,
  },
  {
    name: "multi-line-small",
    description: "Small adjacent line replacement.",
    path: "src/options.ts",
    before: [
      "export const options = [",
      '  "alpha",',
      '  "beta",',
      '  "gamma",',
      '  "delta",',
      "];",
    ].join("\n"),
    readRange: { start: 2, end: 5 },
    editRange: { start: 3, end: 4 },
    legacyOldText: ['  "beta",', '  "gamma",'].join("\n"),
    legacyNewText: ['  "bravo",', '  "charlie",'].join("\n"),
    sourceNewText: ['  "bravo",', '  "charlie",'].join("\n"),
  },
];

const DRIFT_CASE: DriftCase = {
  name: "line-insert-drift",
  description:
    "A line is inserted above the observed range after read; legacy exact edit relocates by text, source-view edit rejects stale line numbers.",
  path: "drift.txt",
  before: ["alpha", "beta", "gamma", "delta"].join("\n"),
  readRange: { start: 2, end: 3 },
  editRange: { start: 2, end: 3 },
  legacyOldText: ["beta", "gamma"].join("\n"),
  legacyNewText: ["BETA", "GAMMA"].join("\n"),
  sourceNewText: ["BETA", "GAMMA"].join("\n"),
  drift: (content) => `inserted\n${content}`,
};

async function runBenchmark(iterations: number): Promise<BenchmarkOutput> {
  const rows: BenchmarkRow[] = [];

  for (const benchmark of CASES) {
    const legacyIterations: IterationMetrics[] = [];
    const sourceIterations: IterationMetrics[] = [];
    for (let index = 0; index < iterations; index += 1) {
      legacyIterations.push(await runLegacyIteration(benchmark));
      sourceIterations.push(await runSourceIteration(benchmark));
    }

    const legacy = summarize(legacyIterations);
    const source = summarize(sourceIterations);
    rows.push({
      case: benchmark.name,
      legacyStatus: legacy.status,
      sourceStatus: source.status,
      legacyTotalBytes: legacy.totalBytes,
      sourceTotalBytes: source.totalBytes,
      legacyTokenProxy: legacy.tokenProxy,
      sourceTokenProxy: source.tokenProxy,
      sourceSavedPercent: savedPercent(legacy.totalBytes, source.totalBytes),
      legacyEditBytes: legacy.editArgsBytes,
      sourceEditBytes: source.editArgsBytes,
      sourceEditSavedPercent: savedPercent(legacy.editArgsBytes, source.editArgsBytes),
      legacyP50Ms: legacy.p50Ms,
      sourceP50Ms: source.p50Ms,
      legacyP95Ms: legacy.p95Ms,
      sourceP95Ms: source.p95Ms,
      description: benchmark.description,
    });
  }

  return {
    rows,
    drift: await runDriftCase(DRIFT_CASE),
  };
}

function printHuman(output: BenchmarkOutput, iterations: number): void {
  console.log(`Filesystem source-view edit benchmark (${iterations} iteration(s) per case)`);
  console.table(
    output.rows.map((row) => ({
      case: row.case,
      legacyStatus: row.legacyStatus,
      sourceStatus: row.sourceStatus,
      legacyTotalBytes: row.legacyTotalBytes,
      sourceTotalBytes: row.sourceTotalBytes,
      sourceSavedPercent: row.sourceSavedPercent,
      legacyTokenProxy: row.legacyTokenProxy,
      sourceTokenProxy: row.sourceTokenProxy,
      legacyEditBytes: row.legacyEditBytes,
      sourceEditBytes: row.sourceEditBytes,
      sourceEditSavedPercent: row.sourceEditSavedPercent,
      legacyP50Ms: row.legacyP50Ms,
      sourceP50Ms: row.sourceP50Ms,
      legacyP95Ms: row.legacyP95Ms,
      sourceP95Ms: row.sourceP95Ms,
    })),
  );

  const totals = output.rows.reduce(
    (sum, row) => ({
      legacyTotalBytes: sum.legacyTotalBytes + row.legacyTotalBytes,
      sourceTotalBytes: sum.sourceTotalBytes + row.sourceTotalBytes,
      legacyEditBytes: sum.legacyEditBytes + row.legacyEditBytes,
      sourceEditBytes: sum.sourceEditBytes + row.sourceEditBytes,
      legacyTokenProxy: sum.legacyTokenProxy + row.legacyTokenProxy,
      sourceTokenProxy: sum.sourceTokenProxy + row.sourceTokenProxy,
    }),
    {
      legacyTotalBytes: 0,
      sourceTotalBytes: 0,
      legacyEditBytes: 0,
      sourceEditBytes: 0,
      legacyTokenProxy: 0,
      sourceTokenProxy: 0,
    },
  );

  console.log("");
  console.table([
    {
      aggregate: "all-success-cases",
      legacyTotalBytes: totals.legacyTotalBytes,
      sourceTotalBytes: totals.sourceTotalBytes,
      sourceSavedPercent: savedPercent(totals.legacyTotalBytes, totals.sourceTotalBytes),
      legacyTokenProxy: totals.legacyTokenProxy,
      sourceTokenProxy: totals.sourceTokenProxy,
      tokenProxySavedPercent: savedPercent(totals.legacyTokenProxy, totals.sourceTokenProxy),
      legacyEditBytes: totals.legacyEditBytes,
      sourceEditBytes: totals.sourceEditBytes,
      sourceEditSavedPercent: savedPercent(totals.legacyEditBytes, totals.sourceEditBytes),
    },
  ]);

  console.log("");
  console.log("Drift behavior:");
  console.table([
    {
      case: output.drift.case,
      legacyStatus: output.drift.legacyStatus,
      sourceStatus: output.drift.sourceStatus,
      description: output.drift.description,
    },
  ]);
}

async function main(): Promise<void> {
  const options = parseCliOptions(Bun.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const output = await runBenchmark(options.iterations);
  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  printHuman(output, options.iterations);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
