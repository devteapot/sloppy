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
  group: "synthetic" | "repo";
  description: string;
  path: string;
  before: string;
  legacyOldText: string;
  legacyNewText: string;
  legacyReadRange: LineRange;
  hashRange: LineRange;
  hashNewText: string;
  drift?: (content: string) => string;
};

type WorkflowStep = {
  name: string;
  path: string;
  needle: string;
  lineCount: number;
  search: string;
  replacement: string;
};

type WorkflowDefinition = {
  name: string;
  description: string;
  files: Record<string, string>;
  steps: WorkflowStep[];
};

type InvokeResult = {
  status?: string;
  data?: unknown;
  error?: unknown;
};

type TaggedLine = {
  line: number;
  tag: string;
  text: string;
};

type TaggedRange = {
  start_line: number;
  start_tag: string;
  end_line: number;
  end_tag: string;
  line_count: number;
};

type HashReadMode = "all" | "boundary";

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
  group: string;
  case: string;
  legacyStatus: string;
  hashAllStatus: string;
  hashBoundaryStatus: string;
  legacyTotalBytes: number;
  hashAllTotalBytes: number;
  hashBoundaryTotalBytes: number;
  legacyTokenProxy: number;
  hashAllTokenProxy: number;
  hashBoundaryTokenProxy: number;
  hashAllSavedPercent: number;
  hashBoundarySavedPercent: number;
  legacyEditBytes: number;
  hashAllEditBytes: number;
  hashBoundaryEditBytes: number;
  hashAllReadResultBytes: number;
  hashBoundaryReadResultBytes: number;
  legacyP50Ms: number;
  hashAllP50Ms: number;
  hashBoundaryP50Ms: number;
  legacyP95Ms: number;
  hashAllP95Ms: number;
  hashBoundaryP95Ms: number;
  description: string;
};

type WorkflowRow = {
  workflow: string;
  stepCount: number;
  legacyStatus: string;
  hashAllStatus: string;
  hashBoundaryStatus: string;
  legacyTotalBytes: number;
  hashAllTotalBytes: number;
  hashBoundaryTotalBytes: number;
  legacyTokenProxy: number;
  hashAllTokenProxy: number;
  hashBoundaryTokenProxy: number;
  hashAllSavedPercent: number;
  hashBoundarySavedPercent: number;
  legacyP50Ms: number;
  hashAllP50Ms: number;
  hashBoundaryP50Ms: number;
  description: string;
};

type BenchmarkOutput = {
  rows: BenchmarkRow[];
  workflows: WorkflowRow[];
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

  for (let index = 0; index < args.length; index++) {
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
      index++;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { iterations, json, help };
}

function usage(): string {
  return [
    "Usage: bun run benchmark:filesystem-edits -- [--iterations N] [--json]",
    "",
    "Compares legacy filesystem edit payloads with tagged hash-based edit_range payloads.",
  ].join("\n");
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "undefined", "utf8");
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

function linesOf(content: string): string[] {
  return content.split("\n");
}

function textForRange(content: string, range: LineRange): string {
  return linesOf(content)
    .slice(range.start - 1, range.end)
    .join("\n");
}

function replaceLine(content: string, line: number, next: string): string {
  const lines = linesOf(content);
  lines[line - 1] = next;
  return lines.join("\n");
}

function findLineRange(content: string, needle: string, lineCount = 1): LineRange {
  const lines = linesOf(content);
  const index = lines.findIndex((line) => line.includes(needle));
  if (index === -1) {
    throw new Error(`Could not find benchmark needle: ${needle}`);
  }
  return {
    start: index + 1,
    end: Math.min(lines.length, index + lineCount),
  };
}

function replaceInRange(content: string, range: LineRange, search: string, replacement: string): string {
  const text = textForRange(content, range);
  if (!text.includes(search)) {
    throw new Error(`Benchmark replacement search text was not found: ${search}`);
  }
  return text.replace(search, replacement);
}

function generateLargeBlockCase(): BenchmarkCase {
  const beforeLines = [
    "export function computeScore(input: number): number {",
    ...Array.from({ length: 30 }, (_, index) => {
      const value = index + 1;
      return `  const part${value} = input + ${value};`;
    }),
    "  return part1 + part30;",
    "}",
    "",
  ];
  const before = beforeLines.join("\n");
  const hashRange = { start: 2, end: 32 };
  const legacyOldText = textForRange(before, hashRange);
  const nextLines = legacyOldText.split("\n");
  nextLines[29] = "  const part30 = input * 30;";

  return {
    name: "large-block",
    group: "synthetic",
    description: "Large multi-line replacement where legacy must echo the old block.",
    path: "synthetic-large.ts",
    before,
    legacyOldText,
    legacyNewText: nextLines.join("\n"),
    legacyReadRange: hashRange,
    hashRange,
    hashNewText: nextLines.join("\n"),
  };
}

function generateLargeFileCase(): BenchmarkCase {
  const before = Array.from({ length: 2000 }, (_, index) => {
    const line = index + 1;
    return line === 1500 ? "line-1500 target = old" : `line-${line} filler`;
  }).join("\n");
  const hashRange = { start: 1500, end: 1500 };

  return {
    name: "large-file-small-edit",
    group: "synthetic",
    description: "Small edit in a large file to show hash/relocation overhead.",
    path: "large-file.txt",
    before,
    legacyOldText: "line-1500 target = old",
    legacyNewText: "line-1500 target = new",
    legacyReadRange: hashRange,
    hashRange,
    hashNewText: "line-1500 target = new",
  };
}

async function buildBenchmarkCases(): Promise<BenchmarkCase[]> {
  const duplicateBefore = [
    'case "alpha":',
    "  if (enabled) {",
    '    return "pending";',
    "  }",
    'case "beta":',
    "  if (enabled) {",
    '    return "pending";',
    "  }",
    'case "gamma":',
    "  if (enabled) {",
    '    return "pending";',
    "  }",
    "",
  ].join("\n");
  const duplicateLegacyRange = { start: 5, end: 8 };

  const readme = await Bun.file("README.md").text();
  const readmeRange = findLineRange(
    readme,
    "The filesystem provider is stateful, not just a bag of file actions.",
  );

  const providerSource = await Bun.file("src/plugins/first-party/filesystem/provider.ts").text();
  const providerRange = findLineRange(providerSource, "const RANGE_EDITS_DESCRIPTION =", 2);

  return [
    {
      name: "small-unique",
      group: "synthetic",
      description: "One small unique line replacement.",
      path: "small.ts",
      before: "const a = 1;\nconst target = 1;\nconst z = 9;\n",
      legacyOldText: "const target = 1;",
      legacyNewText: "const target = 2;",
      legacyReadRange: { start: 2, end: 2 },
      hashRange: { start: 2, end: 2 },
      hashNewText: "const target = 2;",
    },
    generateLargeBlockCase(),
    {
      name: "duplicate-context",
      group: "synthetic",
      description: "Repeated target text where legacy needs surrounding context.",
      path: "duplicate.ts",
      before: duplicateBefore,
      legacyOldText: textForRange(duplicateBefore, duplicateLegacyRange),
      legacyNewText: textForRange(duplicateBefore, duplicateLegacyRange).replace(
        'return "pending";',
        'return "ready";',
      ),
      legacyReadRange: duplicateLegacyRange,
      hashRange: { start: 7, end: 7 },
      hashNewText: '    return "ready";',
    },
    {
      name: "unrelated-drift",
      group: "synthetic",
      description: "External edit outside the target after the read.",
      path: "drift.txt",
      before: "alpha\nbeta\ngamma\ndelta",
      legacyOldText: "beta\ngamma",
      legacyNewText: "BETA\nGAMMA",
      legacyReadRange: { start: 2, end: 3 },
      hashRange: { start: 2, end: 3 },
      hashNewText: "BETA\nGAMMA",
      drift: (content) => content.replace("delta", "delta!"),
    },
    {
      name: "relocated-range",
      group: "synthetic",
      description: "Line inserted above target after read; hash edit relocates by tags.",
      path: "relocated.txt",
      before: "intro\nalpha\nbeta\ngamma\ndelta",
      legacyOldText: "beta\ngamma",
      legacyNewText: "BETA\nGAMMA",
      legacyReadRange: { start: 3, end: 4 },
      hashRange: { start: 3, end: 4 },
      hashNewText: "BETA\nGAMMA",
      drift: (content) => `new\n${content}`,
    },
    {
      name: "target-changed",
      group: "synthetic",
      description: "Target changes after read; both approaches should reject.",
      path: "target-changed.txt",
      before: "alpha\nbeta\ngamma\ndelta",
      legacyOldText: "beta\ngamma",
      legacyNewText: "BETA\nGAMMA",
      legacyReadRange: { start: 2, end: 3 },
      hashRange: { start: 2, end: 3 },
      hashNewText: "BETA\nGAMMA",
      drift: (content) => replaceLine(content, 2, "BETA"),
    },
    {
      name: "ambiguous-relocation",
      group: "synthetic",
      description: "Repeated boundary pair after line drift; hash edit refuses ambiguity.",
      path: "ambiguous.txt",
      before: "a\nstart\nend\nmiddle\nstart\nend\nz",
      legacyOldText: "a\nstart\nend\nmiddle",
      legacyNewText: "a\nSTART\nEND\nmiddle",
      legacyReadRange: { start: 1, end: 4 },
      hashRange: { start: 2, end: 3 },
      hashNewText: "START\nEND",
      drift: (content) => `new\n${content}`,
    },
    generateLargeFileCase(),
    {
      name: "repo-readme",
      group: "repo",
      description: "Real README line edit copied into a temp workspace.",
      path: "README.md",
      before: readme,
      legacyOldText: textForRange(readme, readmeRange),
      legacyNewText: replaceInRange(readme, readmeRange, "stateful", "state-aware"),
      legacyReadRange: readmeRange,
      hashRange: readmeRange,
      hashNewText: replaceInRange(readme, readmeRange, "stateful", "state-aware"),
    },
    {
      name: "repo-filesystem-provider",
      group: "repo",
      description: "Real filesystem provider block copied into a temp workspace.",
      path: "src/plugins/first-party/filesystem/provider.ts",
      before: providerSource,
      legacyOldText: textForRange(providerSource, providerRange),
      legacyNewText: replaceInRange(
        providerSource,
        providerRange,
        "One or more",
        "Benchmark one or more",
      ),
      legacyReadRange: providerRange,
      hashRange: providerRange,
      hashNewText: replaceInRange(providerSource, providerRange, "One or more", "Benchmark one or more"),
    },
  ];
}

async function buildWorkflowDefinitions(): Promise<WorkflowDefinition[]> {
  const readmePath = "README.md";
  const providerPath = "src/plugins/first-party/filesystem/provider.ts";
  const readme = await Bun.file(readmePath).text();
  const providerSource = await Bun.file(providerPath).text();

  return [
    {
      name: "repo-feature-thread",
      description:
        "Four sequential edits across temp copies of README.md and the filesystem provider, simulating a small agent implementation thread.",
      files: {
        [readmePath]: readme,
        [providerPath]: providerSource,
      },
      steps: [
        {
          name: "update-range-description",
          path: providerPath,
          needle: "const RANGE_EDITS_DESCRIPTION =",
          lineCount: 2,
          search: "unique boundary-tag pair",
          replacement: "single boundary-tag pair",
        },
        {
          name: "update-entry-range-description",
          path: providerPath,
          needle: "const ENTRY_RANGE_EDITS_DESCRIPTION =",
          lineCount: 2,
          search: "same line span",
          replacement: "matching line span",
        },
        {
          name: "rename-edit-range-label",
          path: providerPath,
          needle: 'label: "Edit Tagged Range"',
          lineCount: 1,
          search: "Edit Tagged Range",
          replacement: "Edit Tagged Range Benchmark",
        },
        {
          name: "update-readme-filesystem-summary",
          path: readmePath,
          needle: "The filesystem provider is stateful, not just a bag of file actions.",
          lineCount: 1,
          search: "stateful",
          replacement: "state-aware",
        },
      ],
    },
  ];
}

async function runLegacy(caseDef: BenchmarkCase, iterations: number): Promise<ApproachSummary> {
  const root = await mkdtemp(join(tmpdir(), "sloppy-edit-bench-legacy-"));
  const provider = new FilesystemProvider({
    root,
    focus: root,
    recentLimit: 10,
    searchLimit: 20,
    readMaxBytes: Number.MAX_SAFE_INTEGER,
  });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));

  try {
    await consumer.connect();
    await consumer.subscribe("/", 3);
    const metrics: IterationMetrics[] = [];

    for (let index = 0; index < iterations; index++) {
      await writeFixture(root, caseDef.path, caseDef.before);
      const readArgs = {
        path: caseDef.path,
        start_line: caseDef.legacyReadRange.start,
        end_line: caseDef.legacyReadRange.end,
      };
      const editArgs = {
        path: caseDef.path,
        edits: [{ oldText: caseDef.legacyOldText, newText: caseDef.legacyNewText }],
      };

      const started = performance.now();
      const readResult = (await consumer.invoke("/workspace", "read", readArgs)) as InvokeResult;
      if (caseDef.drift) {
        await writeFixture(root, caseDef.path, caseDef.drift(caseDef.before));
      }
      const editResult = (await consumer.invoke("/workspace", "edit", editArgs)) as InvokeResult;
      const elapsedMs = performance.now() - started;

      const readArgsBytes = byteLength(readArgs);
      const readResultBytes = byteLength(readResult);
      const editArgsBytes = byteLength(editArgs);
      const editResultBytes = byteLength(editResult);
      metrics.push({
        elapsedMs,
        readArgsBytes,
        readResultBytes,
        editArgsBytes,
        editResultBytes,
        totalBytes: readArgsBytes + readResultBytes + editArgsBytes + editResultBytes,
        status: statusOf(editResult),
      });
    }

    return summarize(metrics);
  } finally {
    provider.stop();
    await rm(root, { recursive: true, force: true });
  }
}

function taggedLinesFromResult(result: InvokeResult): TaggedLine[] {
  const data = result.data;
  if (!data || typeof data !== "object" || !("lines" in data)) {
    throw new Error("Hash benchmark read did not return tagged lines.");
  }
  const lines = (data as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) {
    throw new Error("Hash benchmark read returned malformed tagged lines.");
  }
  return lines as TaggedLine[];
}

function taggedRangeFromResult(result: InvokeResult): TaggedRange {
  const data = result.data;
  if (!data || typeof data !== "object" || !("range" in data)) {
    throw new Error("Hash benchmark read did not return a tagged boundary range.");
  }
  const range = (data as { range?: unknown }).range;
  if (!range || typeof range !== "object") {
    throw new Error("Hash benchmark read returned malformed boundary range.");
  }
  return range as TaggedRange;
}

async function runHash(
  caseDef: BenchmarkCase,
  iterations: number,
  mode: HashReadMode,
): Promise<ApproachSummary> {
  const root = await mkdtemp(join(tmpdir(), `sloppy-edit-bench-hash-${mode}-`));
  const provider = new FilesystemProvider({
    root,
    focus: root,
    recentLimit: 10,
    searchLimit: 20,
    readMaxBytes: Number.MAX_SAFE_INTEGER,
  });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));

  try {
    await consumer.connect();
    await consumer.subscribe("/", 3);
    const metrics: IterationMetrics[] = [];

    for (let index = 0; index < iterations; index++) {
      await writeFixture(root, caseDef.path, caseDef.before);
      const readArgs = {
        path: caseDef.path,
        start_line: caseDef.hashRange.start,
        end_line: caseDef.hashRange.end,
        include_line_tags: true,
        ...(mode === "boundary" ? { tag_mode: "boundary", include_content: false } : {}),
      };

      const started = performance.now();
      const readResult = (await consumer.invoke("/workspace", "read", readArgs)) as InvokeResult;
      const range =
        mode === "boundary"
          ? taggedRangeFromResult(readResult)
          : (() => {
              const lines = taggedLinesFromResult(readResult);
              const startLine = lines[0];
              const endLine = lines.at(-1);
              if (!startLine || !endLine) {
                throw new Error(`Hash benchmark read returned no lines for ${caseDef.name}.`);
              }
              return {
                start_line: caseDef.hashRange.start,
                start_tag: startLine.tag,
                end_line: caseDef.hashRange.end,
                end_tag: endLine.tag,
              };
            })();

      if (caseDef.drift) {
        await writeFixture(root, caseDef.path, caseDef.drift(caseDef.before));
      }

      const editArgs = {
        path: caseDef.path,
        edits: [
          {
            start_line: range.start_line,
            start_tag: range.start_tag,
            end_line: range.end_line,
            end_tag: range.end_tag,
            new_text: caseDef.hashNewText,
          },
        ],
      };
      const editResult = (await consumer.invoke("/workspace", "edit_range", editArgs)) as InvokeResult;
      const elapsedMs = performance.now() - started;

      const readArgsBytes = byteLength(readArgs);
      const readResultBytes = byteLength(readResult);
      const editArgsBytes = byteLength(editArgs);
      const editResultBytes = byteLength(editResult);
      metrics.push({
        elapsedMs,
        readArgsBytes,
        readResultBytes,
        editArgsBytes,
        editResultBytes,
        totalBytes: readArgsBytes + readResultBytes + editArgsBytes + editResultBytes,
        status: statusOf(editResult),
      });
    }

    return summarize(metrics);
  } finally {
    provider.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function writeWorkflowFiles(root: string, workflow: WorkflowDefinition): Promise<void> {
  for (const [path, content] of Object.entries(workflow.files)) {
    await writeFixture(root, path, content);
  }
}

function statusFromStatuses(statuses: string[]): string {
  return statuses.find((status) => status !== "ok") ?? "ok";
}

function buildWorkflowReplacement(content: string, step: WorkflowStep): {
  range: LineRange;
  oldText: string;
  newText: string;
} {
  const range = findLineRange(content, step.needle, step.lineCount);
  const oldText = textForRange(content, range);
  if (!oldText.includes(step.search)) {
    throw new Error(`Workflow step ${step.name} could not find replacement text: ${step.search}`);
  }
  return {
    range,
    oldText,
    newText: oldText.replace(step.search, step.replacement),
  };
}

async function runLegacyWorkflow(
  workflow: WorkflowDefinition,
  iterations: number,
): Promise<ApproachSummary> {
  const root = await mkdtemp(join(tmpdir(), "sloppy-edit-workflow-legacy-"));
  const provider = new FilesystemProvider({
    root,
    focus: root,
    recentLimit: 20,
    searchLimit: 20,
    readMaxBytes: Number.MAX_SAFE_INTEGER,
  });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));

  try {
    await consumer.connect();
    await consumer.subscribe("/", 3);
    const metrics: IterationMetrics[] = [];

    for (let index = 0; index < iterations; index++) {
      await writeWorkflowFiles(root, workflow);
      const started = performance.now();
      let readArgsBytes = 0;
      let readResultBytes = 0;
      let editArgsBytes = 0;
      let editResultBytes = 0;
      const statuses: string[] = [];

      for (const step of workflow.steps) {
        const content = await Bun.file(join(root, step.path)).text();
        const { range, oldText, newText } = buildWorkflowReplacement(content, step);
        const readArgs = {
          path: step.path,
          start_line: range.start,
          end_line: range.end,
        };
        const editArgs = {
          path: step.path,
          edits: [{ oldText, newText }],
        };
        const readResult = (await consumer.invoke("/workspace", "read", readArgs)) as InvokeResult;
        const editResult = (await consumer.invoke("/workspace", "edit", editArgs)) as InvokeResult;

        readArgsBytes += byteLength(readArgs);
        readResultBytes += byteLength(readResult);
        editArgsBytes += byteLength(editArgs);
        editResultBytes += byteLength(editResult);
        statuses.push(statusOf(editResult));
      }

      const elapsedMs = performance.now() - started;
      metrics.push({
        elapsedMs,
        readArgsBytes,
        readResultBytes,
        editArgsBytes,
        editResultBytes,
        totalBytes: readArgsBytes + readResultBytes + editArgsBytes + editResultBytes,
        status: statusFromStatuses(statuses),
      });
    }

    return summarize(metrics);
  } finally {
    provider.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function runHashWorkflow(
  workflow: WorkflowDefinition,
  iterations: number,
  mode: HashReadMode,
): Promise<ApproachSummary> {
  const root = await mkdtemp(join(tmpdir(), `sloppy-edit-workflow-hash-${mode}-`));
  const provider = new FilesystemProvider({
    root,
    focus: root,
    recentLimit: 20,
    searchLimit: 20,
    readMaxBytes: Number.MAX_SAFE_INTEGER,
  });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));

  try {
    await consumer.connect();
    await consumer.subscribe("/", 3);
    const metrics: IterationMetrics[] = [];

    for (let index = 0; index < iterations; index++) {
      await writeWorkflowFiles(root, workflow);
      const started = performance.now();
      let readArgsBytes = 0;
      let readResultBytes = 0;
      let editArgsBytes = 0;
      let editResultBytes = 0;
      const statuses: string[] = [];

      for (const step of workflow.steps) {
        const content = await Bun.file(join(root, step.path)).text();
        const { range, newText } = buildWorkflowReplacement(content, step);
        const readArgs = {
          path: step.path,
          start_line: range.start,
          end_line: range.end,
          include_line_tags: true,
          ...(mode === "boundary" ? { tag_mode: "boundary", include_content: false } : {}),
        };
        const readResult = (await consumer.invoke("/workspace", "read", readArgs)) as InvokeResult;
        const taggedRange =
          mode === "boundary"
            ? taggedRangeFromResult(readResult)
            : (() => {
                const lines = taggedLinesFromResult(readResult);
                const startLine = lines[0];
                const endLine = lines.at(-1);
                if (!startLine || !endLine) {
                  throw new Error(`Workflow step ${step.name} returned no tagged lines.`);
                }
                return {
                  start_line: range.start,
                  start_tag: startLine.tag,
                  end_line: range.end,
                  end_tag: endLine.tag,
                };
              })();
        const editArgs = {
          path: step.path,
          edits: [
            {
              start_line: taggedRange.start_line,
              start_tag: taggedRange.start_tag,
              end_line: taggedRange.end_line,
              end_tag: taggedRange.end_tag,
              new_text: newText,
            },
          ],
        };
        const editResult = (await consumer.invoke(
          "/workspace",
          "edit_range",
          editArgs,
        )) as InvokeResult;

        readArgsBytes += byteLength(readArgs);
        readResultBytes += byteLength(readResult);
        editArgsBytes += byteLength(editArgs);
        editResultBytes += byteLength(editResult);
        statuses.push(statusOf(editResult));
      }

      const elapsedMs = performance.now() - started;
      metrics.push({
        elapsedMs,
        readArgsBytes,
        readResultBytes,
        editArgsBytes,
        editResultBytes,
        totalBytes: readArgsBytes + readResultBytes + editArgsBytes + editResultBytes,
        status: statusFromStatuses(statuses),
      });
    }

    return summarize(metrics);
  } finally {
    provider.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function runWorkflowBenchmark(iterations: number): Promise<WorkflowRow[]> {
  const workflows = await buildWorkflowDefinitions();
  const rows: WorkflowRow[] = [];

  for (const workflow of workflows) {
    const legacy = await runLegacyWorkflow(workflow, iterations);
    const hashAll = await runHashWorkflow(workflow, iterations, "all");
    const hashBoundary = await runHashWorkflow(workflow, iterations, "boundary");
    rows.push({
      workflow: workflow.name,
      stepCount: workflow.steps.length,
      legacyStatus: legacy.status,
      hashAllStatus: hashAll.status,
      hashBoundaryStatus: hashBoundary.status,
      legacyTotalBytes: legacy.totalBytes,
      hashAllTotalBytes: hashAll.totalBytes,
      hashBoundaryTotalBytes: hashBoundary.totalBytes,
      legacyTokenProxy: legacy.tokenProxy,
      hashAllTokenProxy: hashAll.tokenProxy,
      hashBoundaryTokenProxy: hashBoundary.tokenProxy,
      hashAllSavedPercent: round(
        ((legacy.totalBytes - hashAll.totalBytes) / legacy.totalBytes) * 100,
        1,
      ),
      hashBoundarySavedPercent: round(
        ((legacy.totalBytes - hashBoundary.totalBytes) / legacy.totalBytes) * 100,
        1,
      ),
      legacyP50Ms: legacy.p50Ms,
      hashAllP50Ms: hashAll.p50Ms,
      hashBoundaryP50Ms: hashBoundary.p50Ms,
      description: workflow.description,
    });
  }

  return rows;
}

async function runBenchmark(iterations: number): Promise<BenchmarkOutput> {
  const cases = await buildBenchmarkCases();
  const rows: BenchmarkRow[] = [];

  for (const caseDef of cases) {
    const legacy = await runLegacy(caseDef, iterations);
    const hashAll = await runHash(caseDef, iterations, "all");
    const hashBoundary = await runHash(caseDef, iterations, "boundary");
    rows.push({
      group: caseDef.group,
      case: caseDef.name,
      legacyStatus: legacy.status,
      hashAllStatus: hashAll.status,
      hashBoundaryStatus: hashBoundary.status,
      legacyTotalBytes: legacy.totalBytes,
      hashAllTotalBytes: hashAll.totalBytes,
      hashBoundaryTotalBytes: hashBoundary.totalBytes,
      legacyTokenProxy: legacy.tokenProxy,
      hashAllTokenProxy: hashAll.tokenProxy,
      hashBoundaryTokenProxy: hashBoundary.tokenProxy,
      hashAllSavedPercent: round(
        ((legacy.totalBytes - hashAll.totalBytes) / legacy.totalBytes) * 100,
        1,
      ),
      hashBoundarySavedPercent: round(
        ((legacy.totalBytes - hashBoundary.totalBytes) / legacy.totalBytes) * 100,
        1,
      ),
      legacyEditBytes: legacy.editArgsBytes,
      hashAllEditBytes: hashAll.editArgsBytes,
      hashBoundaryEditBytes: hashBoundary.editArgsBytes,
      hashAllReadResultBytes: hashAll.readResultBytes,
      hashBoundaryReadResultBytes: hashBoundary.readResultBytes,
      legacyP50Ms: legacy.p50Ms,
      hashAllP50Ms: hashAll.p50Ms,
      hashBoundaryP50Ms: hashBoundary.p50Ms,
      legacyP95Ms: legacy.p95Ms,
      hashAllP95Ms: hashAll.p95Ms,
      hashBoundaryP95Ms: hashBoundary.p95Ms,
      description: caseDef.description,
    });
  }

  return {
    rows,
    workflows: await runWorkflowBenchmark(iterations),
  };
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function printSingleStepTable(rows: BenchmarkRow[]): void {
  const headers = [
    "case",
    "legacy",
    "hash_all",
    "hash_boundary",
    "legacy_total",
    "hash_all_total",
    "hash_boundary_total",
    "boundary_saved",
    "legacy_edit",
    "hash_boundary_edit",
    "hash_all_read",
    "hash_boundary_read",
    "legacy_p50",
    "hash_boundary_p50",
  ];
  const table = rows.map((row) => [
    `${row.group}/${row.case}`,
    row.legacyStatus,
    row.hashAllStatus,
    row.hashBoundaryStatus,
    String(row.legacyTotalBytes),
    String(row.hashAllTotalBytes),
    String(row.hashBoundaryTotalBytes),
    `${formatNumber(row.hashBoundarySavedPercent)}%`,
    String(row.legacyEditBytes),
    String(row.hashBoundaryEditBytes),
    String(row.hashAllReadResultBytes),
    String(row.hashBoundaryReadResultBytes),
    `${formatNumber(row.legacyP50Ms)}ms`,
    `${formatNumber(row.hashBoundaryP50Ms)}ms`,
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...table.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");

  console.log("Single-step cases");
  console.log(renderRow(headers));
  console.log(renderRow(headers.map((header) => "-".repeat(header.length))));
  for (const row of table) {
    console.log(renderRow(row));
  }
}

function printWorkflowTable(rows: WorkflowRow[]): void {
  const headers = [
    "workflow",
    "steps",
    "legacy",
    "hash_all",
    "hash_boundary",
    "legacy_total",
    "hash_all_total",
    "hash_boundary_total",
    "boundary_saved",
    "legacy_tokens",
    "boundary_tokens",
    "legacy_p50",
    "hash_boundary_p50",
  ];
  const table = rows.map((row) => [
    row.workflow,
    String(row.stepCount),
    row.legacyStatus,
    row.hashAllStatus,
    row.hashBoundaryStatus,
    String(row.legacyTotalBytes),
    String(row.hashAllTotalBytes),
    String(row.hashBoundaryTotalBytes),
    `${formatNumber(row.hashBoundarySavedPercent)}%`,
    String(row.legacyTokenProxy),
    String(row.hashBoundaryTokenProxy),
    `${formatNumber(row.legacyP50Ms)}ms`,
    `${formatNumber(row.hashBoundaryP50Ms)}ms`,
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...table.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");

  console.log("");
  console.log("Multi-step workflows");
  console.log(renderRow(headers));
  console.log(renderRow(headers.map((header) => "-".repeat(header.length))));
  for (const row of table) {
    console.log(renderRow(row));
  }
}

function printBenchmark(output: BenchmarkOutput, iterations: number): void {
  console.log(`Filesystem edit benchmark (${iterations} iteration${iterations === 1 ? "" : "s"})`);
  console.log("Totals include read args, read result, edit args, and edit result JSON bytes.");
  console.log("hash_all is the original tagged-lines mode; hash_boundary uses boundary tags without content.");
  console.log("Token proxy is bytes/4 and is available in --json output.");
  console.log("");
  printSingleStepTable(output.rows);
  printWorkflowTable(output.workflows);
}

try {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }

  const output = await runBenchmark(options.iterations);
  if (options.json) {
    console.log(JSON.stringify({ iterations: options.iterations, ...output }, null, 2));
  } else {
    printBenchmark(output, options.iterations);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
