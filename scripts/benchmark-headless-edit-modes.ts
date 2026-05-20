import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import YAML from "yaml";

import {
  getHomeConfigPath,
  getWorkspaceConfigPath,
  loadConfigFromPaths,
} from "../src/config/load";
import type { FilesystemEditMode, SloppyConfig } from "../src/config/schema";

const LIVE_BENCHMARK_ENV = "SLOPPY_RUN_LIVE_BENCHMARK";
const DEFAULT_MODES: FilesystemEditMode[] = ["replace", "hash", "both"];
const CASE_IDS = ["tiny", "order-summary", "large-block", "repeated-region", "multi-file"] as const;
const DEFAULT_CASE_IDS: BenchmarkCaseId[] = ["order-summary"];
const repoRoot = resolve(import.meta.dir, "..");

type BenchmarkCaseId = (typeof CASE_IDS)[number];

type CliOptions = {
  runs: number;
  modes: FilesystemEditMode[];
  caseIds: BenchmarkCaseId[];
  timeoutMs: number;
  json: boolean;
  dryRun: boolean;
  keepWorkspaces: boolean;
  artifactDir?: string;
  help: boolean;
};

type CliMetrics = {
  status?: string;
  exitCode?: number;
  elapsedMs?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  modelCalls?: Array<{
    inputTokens?: number;
    outputTokens?: number;
    stateContextTokens?: number;
    stateContextTokenSource?: string;
  }>;
  toolCalls?: number;
  toolResults?: number;
  errorMessage?: string;
};

type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type ValidationResult = {
  ok: boolean;
  checks: Record<string, boolean>;
};

type BenchmarkCase = {
  id: BenchmarkCaseId;
  description: string;
  files: Record<string, string>;
  prompt: string;
  validate(files: Record<string, string>): ValidationResult;
};

type BenchmarkRun = {
  caseId: BenchmarkCaseId;
  caseDescription: string;
  mode: FilesystemEditMode;
  run: number;
  success: boolean;
  exitCode: number;
  elapsedMs: number;
  cliElapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  stateContextTokens?: number;
  modelCalls?: number;
  toolCalls: number;
  toolResults?: number;
  toolCounts: Record<string, number>;
  editActions: string[];
  stdoutChars: number;
  stderrChars: number;
  workspace?: string;
  artifactPath?: string;
  validation: ValidationResult;
  error?: string;
};

type BenchmarkOutput = {
  runs: BenchmarkRun[];
  artifactDir?: string;
};

function usage(): string {
  return [
    "Usage: bun run benchmark:headless-edit-modes -- [options]",
    "",
    "Runs the real headless CLI (-p) against temp workspaces using filesystem editMode=replace/hash/both.",
    "This uses the configured LLM and may consume network/model quota.",
    "",
    "Options:",
    "  --runs <n>              Runs per mode. Default: 1",
    "  --modes <list>          Comma-separated modes. Default: replace,hash,both",
    `  --cases <list>          Comma-separated cases or 'all'. Default: ${DEFAULT_CASE_IDS.join(",")}`,
    "  --timeout-ms <ms>       Timeout per run. Default: 240000",
    "  --json                 Emit JSON",
    "  --dry-run              Build benchmark plan without calling the LLM",
    "  --keep-workspaces      Keep temp workspaces for inspection",
    "  --output-dir <path>    Artifact directory; defaults to test-artifacts/headless-edit-modes/<timestamp>",
    "  -h, --help             Show this help",
    "",
    `Set ${LIVE_BENCHMARK_ENV}=1 to execute live LLM runs.`,
  ].join("\n");
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseModes(value: string): FilesystemEditMode[] {
  const modes = value
    .split(",")
    .map((mode) => mode.trim())
    .filter(Boolean);
  if (modes.length === 0) {
    throw new Error("--modes requires at least one mode.");
  }
  for (const mode of modes) {
    if (mode !== "replace" && mode !== "hash" && mode !== "both") {
      throw new Error(`Unknown edit mode: ${mode}`);
    }
  }
  return modes as FilesystemEditMode[];
}

function parseCases(value: string): BenchmarkCaseId[] {
  if (value.trim() === "all") {
    return [...CASE_IDS];
  }

  const caseIds = value
    .split(",")
    .map((caseId) => caseId.trim())
    .filter(Boolean);
  if (caseIds.length === 0) {
    throw new Error("--cases requires at least one case.");
  }
  for (const caseId of caseIds) {
    if (!CASE_IDS.includes(caseId as BenchmarkCaseId)) {
      throw new Error(`Unknown benchmark case: ${caseId}. Available: ${CASE_IDS.join(", ")}`);
    }
  }
  return caseIds as BenchmarkCaseId[];
}

function parseCliOptions(argv: string[]): CliOptions {
  const args = argv.filter((arg) => arg !== "--");
  const options: CliOptions = {
    runs: 1,
    modes: DEFAULT_MODES,
    caseIds: DEFAULT_CASE_IDS,
    timeoutMs: 240_000,
    json: false,
    dryRun: false,
    keepWorkspaces: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--runs": {
        const parsed = Number.parseInt(takeValue(args, index, arg), 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw new Error("--runs must be a positive integer.");
        }
        options.runs = parsed;
        index += 1;
        break;
      }
      case "--modes":
        options.modes = parseModes(takeValue(args, index, arg));
        index += 1;
        break;
      case "--cases":
        options.caseIds = parseCases(takeValue(args, index, arg));
        index += 1;
        break;
      case "--timeout-ms": {
        const parsed = Number.parseInt(takeValue(args, index, arg), 10);
        if (!Number.isFinite(parsed) || parsed < 1000) {
          throw new Error("--timeout-ms must be an integer >= 1000.");
        }
        options.timeoutMs = parsed;
        index += 1;
        break;
      }
      case "--json":
        options.json = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--keep-workspaces":
        options.keepWorkspaces = true;
        break;
      case "--output-dir":
        options.artifactDir = takeValue(args, index, arg);
        index += 1;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function defaultArtifactDir(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(repoRoot, "test-artifacts/headless-edit-modes", stamp);
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-");
}

function runArtifactPath(
  artifactDir: string | undefined,
  benchmarkCase: BenchmarkCase,
  mode: FilesystemEditMode,
  run: number,
): string | undefined {
  if (!artifactDir) {
    return undefined;
  }
  return join(
    artifactDir,
    `${String(run).padStart(2, "0")}-${safeSegment(benchmarkCase.id)}-${safeSegment(mode)}`,
  );
}

function compactUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => compactUndefined(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, compactUndefined(item)]),
  );
}

function buildBenchmarkConfig(baseConfig: SloppyConfig, mode: FilesystemEditMode): string {
  const config = compactUndefined({
    llm: baseConfig.llm,
    agent: {
      ...baseConfig.agent,
      maxIterations: Math.max(baseConfig.agent.maxIterations, 10),
    },
    session: {
      persistSnapshots: false,
      persistenceDir: ".sloppy/sessions",
    },
    providers: {
      discovery: {
        enabled: false,
        paths: [],
      },
    },
    plugins: {
      "persistent-goal": { enabled: false },
      terminal: { enabled: false, cwd: "." },
      filesystem: {
        enabled: true,
        root: ".",
        focus: ".",
        recentLimit: baseConfig.plugins.filesystem.recentLimit,
        searchLimit: baseConfig.plugins.filesystem.searchLimit,
        readMaxBytes: baseConfig.plugins.filesystem.readMaxBytes,
        contentRefThresholdBytes: baseConfig.plugins.filesystem.contentRefThresholdBytes,
        previewBytes: baseConfig.plugins.filesystem.previewBytes,
        editMode: mode,
      },
      memory: { enabled: false },
      skills: { enabled: false },
      "meta-runtime": { enabled: false },
      web: { enabled: false },
      browser: { enabled: false },
      cron: { enabled: false },
      messaging: { enabled: false },
      delegation: { enabled: false },
      spec: { enabled: false },
      vision: { enabled: false },
      mcp: { enabled: false, connectOnStart: false, servers: {} },
      workspaces: { enabled: false },
      a2a: { enabled: false, fetchOnStart: false, agents: {} },
    },
  });

  return YAML.stringify(config);
}

function commonPrompt(parts: string[]): string {
  return [
    "Use only the filesystem provider. The terminal provider is disabled; do not try shell commands.",
    "This is a benchmark of the active filesystem edit mode, so use the available targeted edit affordances for existing files instead of rewriting whole files.",
    ...parts,
    "After editing, reread the changed sections to verify them.",
    "When done, reply exactly BENCHMARK_DONE.",
  ].join(" ");
}

function validation(checks: Record<string, boolean>): ValidationResult {
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
  };
}

const TINY_PATH = "src/feature-flag.ts";
const TINY_FIXTURE = `export const checkoutExperiment = "control";
export const searchExperiment = "control";
`;

const ORDER_SOURCE_PATH = "src/order-summary.ts";
const ORDER_README_PATH = "README.md";

const ORDER_SOURCE_FIXTURE = `export type OrderLine = {
  sku: string;
  quantity: number;
  unitPrice: number;
};

export type Order = {
  id: string;
  lines: OrderLine[];
};

export function summarizeOrder(order: Order): string {
  const total = order.lines.reduce((sum, line) => {
    return sum + line.quantity * line.unitPrice;
  }, 0);

  return \`\${order.id}: \${total}\`;
}
`;

const ORDER_README_FIXTURE = `# Order Summary

This benchmark workspace contains a tiny order-summary utility.

## Expected output

The summary currently returns a compact internal string.

## Notes

Keep the utility dependency-free and readable.
`;

function largeBlockFixture(): string {
  const rows = Array.from(
    { length: 90 },
    (_, index) => `  rows.push("metric-${String(index + 1).padStart(2, "0")}: pending");`,
  );
  return [
    "export type ReportInput = {",
    "  id: string;",
    "  severity: string;",
    "  total: number;",
    "  items: string[];",
    "};",
    "",
    "export function renderReport(input: ReportInput): string {",
    "  const rows: string[] = [];",
    ...rows,
    '  rows.push(`id: ${input.id}`);',
    '  rows.push(`total: ${input.total}`);',
    '  return rows.join("\\n");',
    "}",
    "",
  ].join("\n");
}

const REPEATED_SOURCE_PATH = "src/workflow-state.ts";
const REPEATED_SOURCE_FIXTURE = `export type WorkflowKind = "alpha" | "beta" | "gamma";

export function resolveWorkflowState(kind: WorkflowKind, enabled: boolean): string {
  switch (kind) {
    case "alpha":
      if (enabled) {
        return "pending";
      }
      return "blocked";
    case "beta":
      if (enabled) {
        return "pending";
      }
      return "blocked";
    case "gamma":
      if (enabled) {
        return "pending";
      }
      return "blocked";
  }
}
`;

const MULTI_PRICING_PATH = "src/pricing.ts";
const MULTI_PRICING_FIXTURE = `export type Line = {
  sku: string;
  quantity: number;
  unitPrice: number;
};

export function subtotal(lines: Line[]): number {
  return lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
}
`;

const MULTI_STATUS_PATH = "src/status.ts";
const MULTI_STATUS_FIXTURE = `export function statusForTotal(total: number): string {
  return total > 0 ? "open" : "empty";
}
`;

const MULTI_README_PATH = "docs/pricing.md";
const MULTI_README_FIXTURE = `# Pricing

Subtotal is the sum of quantity times unit price.
`;

function buildCases(): BenchmarkCase[] {
  return [
    {
      id: "tiny",
      description: "One tiny exact line edit in one file.",
      files: {
        [TINY_PATH]: TINY_FIXTURE,
      },
      prompt: commonPrompt([
        `Inspect ${TINY_PATH}.`,
        `Change only checkoutExperiment from "control" to "treatment"; leave searchExperiment unchanged.`,
      ]),
      validate: (files) => {
        const source = files[TINY_PATH] ?? "";
        return validation({
          checkoutTreatment: source.includes('checkoutExperiment = "treatment"'),
          searchStillControl: source.includes('searchExperiment = "control"'),
        });
      },
    },
    {
      id: "order-summary",
      description: "Two-file implementation-plus-docs task with moderate block edits.",
      files: {
        [ORDER_SOURCE_PATH]: ORDER_SOURCE_FIXTURE,
        [ORDER_README_PATH]: ORDER_README_FIXTURE,
      },
      prompt: commonPrompt([
        `Inspect ${ORDER_SOURCE_PATH} and ${ORDER_README_PATH}.`,
        `Update ${ORDER_SOURCE_PATH} so summarizeOrder(order) returns exactly this shape: ORDER <id>: <itemCount> item(s), total $<total> (<status>).`,
        "In the implementation, itemCount is the sum of line.quantity, total is the sum of quantity * unitPrice formatted with toFixed(2), and status is priority when total >= 100 otherwise standard.",
        `Update ${ORDER_README_PATH} so the Expected output section documents the exact shape ORDER <id>: <itemCount> item(s), total $<total> (<status>) and the priority rule.`,
      ]),
      validate: (files) => {
        const source = files[ORDER_SOURCE_PATH] ?? "";
        const readme = files[ORDER_README_PATH] ?? "";
        return validation({
          orderPrefix: source.includes("ORDER"),
          itemCount: source.includes("itemCount") || source.includes("item_count"),
          quantity: source.includes("quantity"),
          unitPrice: source.includes("unitPrice"),
          toFixed: source.includes("toFixed(2)"),
          priority: source.includes("priority"),
          standard: source.includes("standard"),
          outputShape: readme.includes("ORDER <id>: <itemCount> item(s), total $<total> (<status>)"),
          priorityRule: readme.includes("priority") && readme.includes("100"),
        });
      },
    },
    {
      id: "large-block",
      description: "Large generated-looking function body replacement in one file.",
      files: {
        "src/report.ts": largeBlockFixture(),
      },
      prompt: commonPrompt([
        "Inspect src/report.ts.",
        "Replace renderReport with a concise implementation that returns exactly five lines: REPORT <id>, severity <uppercased severity>, items <item count>, total $<total.toFixed(2)>, and status alert when severity is critical otherwise normal.",
        "Keep the ReportInput type unchanged.",
      ]),
      validate: (files) => {
        const source = files["src/report.ts"] ?? "";
        return validation({
          reportPrefix: source.includes("REPORT"),
          upperSeverity: source.includes("toUpperCase"),
          itemCount: source.includes("items.length"),
          toFixed: source.includes("toFixed(2)"),
          alert: source.includes("alert"),
          normal: source.includes("normal"),
          generatedRowsRemoved: !source.includes("metric-90: pending"),
        });
      },
    },
    {
      id: "repeated-region",
      description: "Repeated similar branches where exact replacement needs context.",
      files: {
        [REPEATED_SOURCE_PATH]: REPEATED_SOURCE_FIXTURE,
        "README.md": "# Workflow State\n\nEnabled workflows currently return pending.\n",
      },
      prompt: commonPrompt([
        `Inspect ${REPEATED_SOURCE_PATH} and README.md.`,
        `Update only the beta enabled branch in ${REPEATED_SOURCE_PATH} so it returns "ready" instead of "pending". Alpha and gamma enabled branches must still return "pending".`,
        "Update README.md to say beta returns ready when enabled.",
      ]),
      validate: (files) => {
        const source = files[REPEATED_SOURCE_PATH] ?? "";
        const readme = files["README.md"] ?? "";
        const betaReady = /case "beta":[\s\S]*return "ready";/.test(source);
        const alphaPending = /case "alpha":[\s\S]*return "pending";[\s\S]*case "beta":/.test(source);
        const gammaPending = /case "gamma":[\s\S]*return "pending";/.test(source);
        return validation({
          betaReady,
          alphaPending,
          gammaPending,
          readmeReady: readme.includes("beta") && readme.includes("ready"),
        });
      },
    },
    {
      id: "multi-file",
      description: "Three-file feature thread touching shared code and docs.",
      files: {
        [MULTI_PRICING_PATH]: MULTI_PRICING_FIXTURE,
        [MULTI_STATUS_PATH]: MULTI_STATUS_FIXTURE,
        [MULTI_README_PATH]: MULTI_README_FIXTURE,
      },
      prompt: commonPrompt([
        `Inspect ${MULTI_PRICING_PATH}, ${MULTI_STATUS_PATH}, and ${MULTI_README_PATH}.`,
        `In ${MULTI_PRICING_PATH}, add exported function discountEligible(lines: Line[]): boolean that returns true when subtotal(lines) >= 250.`,
        `In ${MULTI_STATUS_PATH}, change statusForTotal so totals >= 250 return "discount", totals > 0 return "open", otherwise "empty".`,
        `In ${MULTI_README_PATH}, document that carts at or above 250 are discount eligible.`,
      ]),
      validate: (files) => {
        const pricing = files[MULTI_PRICING_PATH] ?? "";
        const status = files[MULTI_STATUS_PATH] ?? "";
        const readme = files[MULTI_README_PATH] ?? "";
        return validation({
          discountFunction: pricing.includes("discountEligible"),
          usesSubtotal: pricing.includes("subtotal(lines)") || pricing.includes("subtotal("),
          thresholdPricing: pricing.includes("250"),
          discountStatus: status.includes('"discount"'),
          statusThreshold: status.includes("250"),
          readmeDiscount: readme.includes("discount") && readme.includes("250"),
        });
      },
    },
  ];
}

const BENCHMARK_CASES = buildCases();

function caseById(caseId: BenchmarkCaseId): BenchmarkCase {
  const benchmarkCase = BENCHMARK_CASES.find((item) => item.id === caseId);
  if (!benchmarkCase) {
    throw new Error(`Unknown benchmark case: ${caseId}`);
  }
  return benchmarkCase;
}

async function writeFixture(root: string, path: string, content: string): Promise<void> {
  const fullPath = join(root, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

async function writeWorkspace(
  root: string,
  benchmarkCase: BenchmarkCase,
  configYaml: string,
): Promise<void> {
  for (const [path, content] of Object.entries(benchmarkCase.files)) {
    await writeFixture(root, path, content);
  }
  await writeFixture(root, ".sloppy/config.yaml", configYaml);
}

async function collectProcess(
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">,
  timeoutMs: number,
): Promise<ProcessResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const output = Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`headless edit-mode benchmark timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([output, deadline]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function readCaseFiles(
  root: string,
  benchmarkCase: BenchmarkCase,
): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      Object.keys(benchmarkCase.files).map(async (path) => {
        try {
          return [path, await readFile(join(root, path), "utf8")];
        } catch {
          return [path, ""];
        }
      }),
    ),
  );
}

function countTools(stdout: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\[tool\]\s+([^\s]+)\s/);
    if (!match?.[1]) {
      continue;
    }
    counts[match[1]] = (counts[match[1]] ?? 0) + 1;
  }
  return counts;
}

function editActions(toolCounts: Record<string, number>): string[] {
  return Object.keys(toolCounts)
    .filter(
      (name) =>
        name.startsWith("filesystem__") &&
        (name.includes("_edit_range") || name.includes("_edit") || name.includes("_write")),
    )
    .sort();
}

async function readMetrics(metricsPath: string): Promise<CliMetrics | undefined> {
  try {
    return JSON.parse(await readFile(metricsPath, "utf8")) as CliMetrics;
  } catch {
    return undefined;
  }
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sumStateContextTokens(metrics: CliMetrics | undefined): number | undefined {
  if (!metrics?.modelCalls) {
    return undefined;
  }
  const values = metrics.modelCalls
    .map((call) => call.stateContextTokens)
    .filter((value): value is number => typeof value === "number");
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0);
}

async function writeRunArtifacts(options: {
  artifactPath?: string;
  benchmarkCase: BenchmarkCase;
  mode: FilesystemEditMode;
  run: number;
  workspace: string;
  configYaml: string;
  metricsPath: string;
  eventLogPath: string;
  processResult: ProcessResult;
  metrics?: CliMetrics;
  validation: ValidationResult;
  finalFiles: Record<string, string>;
  runResult: BenchmarkRun;
}): Promise<void> {
  if (!options.artifactPath) {
    return;
  }
  const artifactPath = options.artifactPath;

  await mkdir(artifactPath, { recursive: true });
  await Promise.all([
    writeText(join(artifactPath, "prompt.txt"), `${options.benchmarkCase.prompt}\n`),
    writeText(join(artifactPath, "stdout.txt"), options.processResult.stdout),
    writeText(join(artifactPath, "stderr.txt"), options.processResult.stderr),
    writeText(join(artifactPath, "config.yaml"), options.configYaml),
    writeText(join(artifactPath, "workspace.txt"), `${options.workspace}\n`),
    writeJson(join(artifactPath, "case.json"), {
      id: options.benchmarkCase.id,
      description: options.benchmarkCase.description,
      mode: options.mode,
      run: options.run,
      files: options.benchmarkCase.files,
    }),
    writeJson(join(artifactPath, "validation.json"), options.validation),
    writeJson(join(artifactPath, "summary.json"), options.runResult),
  ]);

  const [metricsText, eventLogText] = await Promise.all([
    readOptionalText(options.metricsPath),
    readOptionalText(options.eventLogPath),
  ]);
  if (metricsText !== undefined) {
    await writeText(join(artifactPath, "metrics.json"), metricsText);
  } else if (options.metrics) {
    await writeJson(join(artifactPath, "metrics.json"), options.metrics);
  }
  if (eventLogText !== undefined) {
    await writeText(join(artifactPath, "events.jsonl"), eventLogText);
  }

  await Promise.all(
    Object.entries(options.finalFiles).map(([path, content]) =>
      writeText(join(artifactPath, "final", path), content),
    ),
  );
}

async function runModeOnce(
  benchmarkCase: BenchmarkCase,
  baseConfig: SloppyConfig,
  mode: FilesystemEditMode,
  run: number,
  options: CliOptions,
): Promise<BenchmarkRun> {
  const workspace = await mkdtemp(join(tmpdir(), `sloppy-headless-${benchmarkCase.id}-${mode}-`));
  const metricsPath = join(workspace, ".sloppy/cli-metrics.json");
  const eventLogPath = join(workspace, ".sloppy/events.jsonl");
  const configYaml = buildBenchmarkConfig(baseConfig, mode);
  const artifactPath = runArtifactPath(options.artifactDir, benchmarkCase, mode, run);
  const started = performance.now();

  try {
    await writeWorkspace(workspace, benchmarkCase, configYaml);

    if (options.dryRun) {
      const validation = benchmarkCase.validate(benchmarkCase.files);
      return {
        caseId: benchmarkCase.id,
        caseDescription: benchmarkCase.description,
        mode,
        run,
        success: false,
        exitCode: 0,
        elapsedMs: 0,
        toolCalls: 0,
        toolCounts: {},
        editActions: [],
        stdoutChars: 0,
        stderrChars: 0,
        workspace: options.keepWorkspaces ? workspace : undefined,
        artifactPath,
        validation,
        error: "dry_run",
      };
    }

    const proc = Bun.spawn({
      cmd: [process.execPath, "run", join(repoRoot, "src/cli.ts"), "-p", benchmarkCase.prompt],
      cwd: workspace,
      env: {
        ...process.env,
        SLOPPY_CLI_METRICS_PATH: metricsPath,
        SLOPPY_EVENT_LOG: eventLogPath,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let result: ProcessResult;
    let processError: string | undefined;
    try {
      result = await collectProcess(proc, options.timeoutMs);
    } catch (error) {
      processError = error instanceof Error ? error.message : String(error);
      result = {
        exitCode: 1,
        stdout: "",
        stderr: processError,
      };
    }
    const [finalFiles, metrics] = await Promise.all([
      readCaseFiles(workspace, benchmarkCase),
      readMetrics(metricsPath),
    ]);
    const validation = benchmarkCase.validate(finalFiles);
    const toolCounts = countTools(result.stdout);
    const success = !processError && result.exitCode === 0 && validation.ok;

    const runResult: BenchmarkRun = {
      caseId: benchmarkCase.id,
      caseDescription: benchmarkCase.description,
      mode,
      run,
      success,
      exitCode: result.exitCode,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      cliElapsedMs: metrics?.elapsedMs,
      inputTokens: metrics?.usage?.inputTokens,
      outputTokens: metrics?.usage?.outputTokens,
      stateContextTokens: sumStateContextTokens(metrics),
      modelCalls: metrics?.modelCalls?.length,
      toolCalls: metrics?.toolCalls ?? Object.values(toolCounts).reduce((sum, value) => sum + value, 0),
      toolResults: metrics?.toolResults,
      toolCounts,
      editActions: editActions(toolCounts),
      stdoutChars: result.stdout.length,
      stderrChars: result.stderr.length,
      workspace: options.keepWorkspaces ? workspace : undefined,
      artifactPath,
      validation,
      error: success
        ? undefined
        : processError ??
          metrics?.errorMessage ??
          result.stderr.split("\n").find((line) => line.includes("[error]")),
    };
    await writeRunArtifacts({
      artifactPath,
      benchmarkCase,
      mode,
      run,
      workspace,
      configYaml,
      metricsPath,
      eventLogPath,
      processResult: result,
      metrics,
      validation,
      finalFiles,
      runResult,
    });
    return runResult;
  } finally {
    if (!options.keepWorkspaces) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

function average(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === "number");
  if (present.length === 0) {
    return undefined;
  }
  return Math.round((present.reduce((sum, value) => sum + value, 0) / present.length) * 100) / 100;
}

function summarizeCaseMode(
  runs: BenchmarkRun[],
  caseId: BenchmarkCaseId,
  mode: FilesystemEditMode,
) {
  const modeRuns = runs.filter((run) => run.caseId === caseId && run.mode === mode);
  return {
    case: caseId,
    mode,
    success: `${modeRuns.filter((run) => run.success).length}/${modeRuns.length}`,
    avgElapsedMs: average(modeRuns.map((run) => run.elapsedMs)),
    avgInputTokens: average(modeRuns.map((run) => run.inputTokens)),
    avgOutputTokens: average(modeRuns.map((run) => run.outputTokens)),
    avgStateContextTokens: average(modeRuns.map((run) => run.stateContextTokens)),
    avgModelCalls: average(modeRuns.map((run) => run.modelCalls)),
    avgToolCalls: average(modeRuns.map((run) => run.toolCalls)),
    editActions: [...new Set(modeRuns.flatMap((run) => run.editActions))].join(",") || "-",
  };
}

function printHuman(output: BenchmarkOutput, options: CliOptions): void {
  if (options.dryRun) {
    console.log("Headless edit-mode benchmark dry run");
    console.log(`Cases: ${options.caseIds.join(", ")}`);
    console.log(`Modes: ${options.modes.join(", ")}`);
    console.log(`Runs per mode: ${options.runs}`);
    console.log("");
    for (const caseId of options.caseIds) {
      const benchmarkCase = caseById(caseId);
      console.log(`${benchmarkCase.id}: ${benchmarkCase.description}`);
      console.log(benchmarkCase.prompt);
      console.log("");
    }
    console.log("");
    console.log(`Set ${LIVE_BENCHMARK_ENV}=1 to execute live LLM runs.`);
    return;
  }

  console.log(
    `Headless edit-mode live benchmark (${options.runs} run${options.runs === 1 ? "" : "s"}/case/mode)`,
  );
  if (output.artifactDir) {
    console.log(`Artifacts: ${output.artifactDir}`);
  }
  console.table(
    output.runs
      .map((run) => summarizeCaseMode(output.runs, run.caseId, run.mode))
      .filter(
        (row, index, rows) =>
          rows.findIndex((item) => item.case === row.case && item.mode === row.mode) === index,
      ),
  );

  const failed = output.runs.filter((run) => !run.success);
  if (failed.length > 0) {
    console.log("");
    console.log("Failures:");
    for (const run of failed) {
      console.log(
        `${run.caseId}/${run.mode}#${run.run}: exit=${run.exitCode} error=${run.error ?? "validation_failed"} validation=${JSON.stringify(run.validation)} artifact=${run.artifactPath ?? "-"}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const options = parseCliOptions(Bun.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  if (!options.dryRun && Bun.env[LIVE_BENCHMARK_ENV] !== "1") {
    throw new Error(`Refusing to run live benchmark without ${LIVE_BENCHMARK_ENV}=1.`);
  }
  if (!options.dryRun) {
    options.artifactDir = resolve(repoRoot, options.artifactDir ?? defaultArtifactDir());
    await mkdir(options.artifactDir, { recursive: true });
  }

  const baseConfig = await loadConfigFromPaths(getHomeConfigPath(), getWorkspaceConfigPath(repoRoot), {
    cwd: repoRoot,
  });
  const runs: BenchmarkRun[] = [];
  for (let run = 1; run <= options.runs; run += 1) {
    for (const caseId of options.caseIds) {
      const benchmarkCase = caseById(caseId);
      for (const mode of options.modes) {
        runs.push(await runModeOnce(benchmarkCase, baseConfig, mode, run, options));
      }
    }
  }

  const output: BenchmarkOutput = { runs, artifactDir: options.artifactDir };
  if (output.artifactDir && !options.dryRun) {
    await writeJson(join(output.artifactDir, "benchmark.json"), output);
  }
  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    printHuman(output, options);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
