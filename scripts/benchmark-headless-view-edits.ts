import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import YAML from "yaml";

import {
  getHomeConfigPath,
  getWorkspaceConfigPath,
  loadConfigFromPaths,
} from "../src/config/load";
import type { SloppyConfig } from "../src/config/schema";

const LIVE_BENCHMARK_ENV = "SLOPPY_RUN_LIVE_BENCHMARK";
const APPROACHES = ["legacy", "source"] as const;
const CASE_IDS = ["tiny", "large-block", "repeated-region", "multi-file"] as const;
const DEFAULT_CASE_IDS: BenchmarkCaseId[] = ["large-block"];
const repoRoot = resolve(import.meta.dir, "..");

type Approach = (typeof APPROACHES)[number];
type BenchmarkCaseId = (typeof CASE_IDS)[number];

type CliOptions = {
  runs: number;
  approaches: Approach[];
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
  task: string[];
  validate(files: Record<string, string>): ValidationResult;
};

type BenchmarkRun = {
  caseId: BenchmarkCaseId;
  caseDescription: string;
  approach: Approach;
  run: number;
  success: boolean;
  approachSatisfied: boolean;
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
    "Usage: bun run benchmark:headless-view-edits -- [options]",
    "",
    "Runs the real headless CLI (-p) against temp workspaces and compares legacy edit vs source-view edit_range.",
    "This uses the configured LLM and may consume network/model quota.",
    "",
    "Options:",
    "  --runs <n>              Runs per case/approach. Default: 1",
    "  --approaches <list>     Comma-separated approaches. Default: legacy,source",
    `  --cases <list>          Comma-separated cases or 'all'. Default: ${DEFAULT_CASE_IDS.join(",")}`,
    "  --timeout-ms <ms>       Timeout per run. Default: 240000",
    "  --json                 Emit JSON",
    "  --dry-run              Build benchmark plan without calling the LLM",
    "  --keep-workspaces      Keep temp workspaces for inspection",
    "  --output-dir <path>    Artifact directory; defaults to test-artifacts/headless-view-edits/<timestamp>",
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

function parseApproaches(value: string): Approach[] {
  const approaches = value
    .split(",")
    .map((approach) => approach.trim())
    .filter(Boolean);
  if (approaches.length === 0) {
    throw new Error("--approaches requires at least one approach.");
  }
  for (const approach of approaches) {
    if (!APPROACHES.includes(approach as Approach)) {
      throw new Error(`Unknown approach: ${approach}. Available: ${APPROACHES.join(", ")}`);
    }
  }
  return approaches as Approach[];
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
    approaches: [...APPROACHES],
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
      case "--approaches":
        options.approaches = parseApproaches(takeValue(args, index, arg));
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
  return join(repoRoot, "test-artifacts/headless-view-edits", stamp);
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-");
}

function runArtifactPath(
  artifactDir: string | undefined,
  benchmarkCase: BenchmarkCase,
  approach: Approach,
  run: number,
): string | undefined {
  if (!artifactDir) {
    return undefined;
  }
  return join(
    artifactDir,
    `${String(run).padStart(2, "0")}-${safeSegment(benchmarkCase.id)}-${safeSegment(approach)}`,
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

function buildBenchmarkConfig(baseConfig: SloppyConfig): string {
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

function approachInstruction(approach: Approach): string {
  if (approach === "legacy") {
    return "For edits, use the filesystem edit action with oldText/newText. Do not use edit_range and do not use write for existing files.";
  }
  return "For edits, use filesystem read first, then use filesystem edit_range with source_version, start_line, end_line, and new_text. Do not use edit and do not use write for existing files.";
}

function promptFor(benchmarkCase: BenchmarkCase, approach: Approach): string {
  return [
    "Use only the filesystem provider. The terminal provider is disabled; do not try shell commands.",
    approachInstruction(approach),
    ...benchmarkCase.task,
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

function largeBlockFixture(): string {
  const rows = Array.from(
    { length: 80 },
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

const CASES: BenchmarkCase[] = [
  {
    id: "tiny",
    description: "One tiny exact line edit in one file.",
    files: {
      "src/feature-flag.ts": [
        'export const checkoutExperiment = "control";',
        'export const searchExperiment = "control";',
        "",
      ].join("\n"),
    },
    task: [
      "Inspect src/feature-flag.ts.",
      'Change only checkoutExperiment from "control" to "treatment"; leave searchExperiment unchanged.',
    ],
    validate: (files) => {
      const source = files["src/feature-flag.ts"] ?? "";
      return validation({
        checkoutTreatment: source.includes('checkoutExperiment = "treatment"'),
        searchStillControl: source.includes('searchExperiment = "control"'),
      });
    },
  },
  {
    id: "large-block",
    description: "Large generated-looking function body replacement in one file.",
    files: {
      "src/report.ts": largeBlockFixture(),
    },
    task: [
      "Inspect src/report.ts.",
      "Replace renderReport with a concise implementation that returns exactly five lines: REPORT <id>, severity <uppercased severity>, items <item count>, total $<total.toFixed(2)>, and status alert when severity is critical otherwise normal.",
      "Keep the ReportInput type unchanged.",
    ],
    validate: (files) => {
      const source = files["src/report.ts"] ?? "";
      return validation({
        reportPrefix: source.includes("REPORT"),
        upperSeverity: source.includes("toUpperCase"),
        itemCount: source.includes("items.length"),
        toFixed: source.includes("toFixed(2)"),
        alert: source.includes("alert"),
        normal: source.includes("normal"),
        generatedRowsRemoved: !source.includes("metric-80: pending"),
      });
    },
  },
  {
    id: "repeated-region",
    description: "Repeated similar branches where exact replacement needs context.",
    files: {
      "src/workflow-state.ts": [
        'export type WorkflowKind = "alpha" | "beta" | "gamma";',
        "",
        "export function resolveWorkflowState(kind: WorkflowKind, enabled: boolean): string {",
        "  switch (kind) {",
        '    case "alpha":',
        "      if (enabled) {",
        '        return "pending";',
        "      }",
        '      return "blocked";',
        '    case "beta":',
        "      if (enabled) {",
        '        return "pending";',
        "      }",
        '      return "blocked";',
        '    case "gamma":',
        "      if (enabled) {",
        '        return "pending";',
        "      }",
        '      return "blocked";',
        "  }",
        "}",
        "",
      ].join("\n"),
      "README.md": "# Workflow State\n\nEnabled workflows currently return pending.\n",
    },
    task: [
      "Inspect src/workflow-state.ts and README.md.",
      'Update only the beta enabled branch in src/workflow-state.ts so it returns "ready" instead of "pending". Alpha and gamma enabled branches must still return "pending".',
      "Update README.md to say beta returns ready when enabled.",
    ],
    validate: (files) => {
      const source = files["src/workflow-state.ts"] ?? "";
      const readme = files["README.md"] ?? "";
      return validation({
        betaReady: /case "beta":[\s\S]*return "ready";/.test(source),
        alphaPending: /case "alpha":[\s\S]*return "pending";[\s\S]*case "beta":/.test(source),
        gammaPending: /case "gamma":[\s\S]*return "pending";/.test(source),
        readmeReady: readme.includes("beta") && readme.includes("ready"),
      });
    },
  },
  {
    id: "multi-file",
    description: "Three-file feature thread touching shared code and docs.",
    files: {
      "src/pricing.ts": [
        "export type Line = {",
        "  sku: string;",
        "  quantity: number;",
        "  unitPrice: number;",
        "};",
        "",
        "export function subtotal(lines: Line[]): number {",
        "  return lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);",
        "}",
        "",
      ].join("\n"),
      "src/status.ts": [
        "export function statusForTotal(total: number): string {",
        '  return total > 0 ? "open" : "empty";',
        "}",
        "",
      ].join("\n"),
      "docs/pricing.md": "# Pricing\n\nSubtotal is the sum of quantity times unit price.\n",
    },
    task: [
      "Inspect src/pricing.ts, src/status.ts, and docs/pricing.md.",
      "In src/pricing.ts, add exported function discountEligible(lines: Line[]): boolean that returns true when subtotal(lines) >= 250.",
      'In src/status.ts, change statusForTotal so totals >= 250 return "discount", totals > 0 return "open", otherwise "empty".',
      "In docs/pricing.md, document that carts at or above 250 are discount eligible.",
    ],
    validate: (files) => {
      const pricing = files["src/pricing.ts"] ?? "";
      const status = files["src/status.ts"] ?? "";
      const readme = files["docs/pricing.md"] ?? "";
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

function caseById(caseId: BenchmarkCaseId): BenchmarkCase {
  const benchmarkCase = CASES.find((item) => item.id === caseId);
  if (!benchmarkCase) {
    throw new Error(`Unknown benchmark case: ${caseId}`);
  }
  return benchmarkCase;
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeWorkspace(
  root: string,
  benchmarkCase: BenchmarkCase,
  configYaml: string,
): Promise<void> {
  for (const [path, content] of Object.entries(benchmarkCase.files)) {
    await writeText(join(root, path), content);
  }
  await writeText(join(root, ".sloppy/config.yaml"), configYaml);
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
      reject(new Error(`headless source-view benchmark timed out after ${timeoutMs}ms`));
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

function approachSatisfied(approach: Approach, actions: string[]): boolean {
  const usedEditRange = actions.some((actionName) => actionName.includes("_edit_range"));
  const usedEdit = actions.some(
    (actionName) => actionName.includes("_edit") && !actionName.includes("_edit_range"),
  );
  const usedWrite = actions.some((actionName) => actionName.includes("_write"));
  return approach === "legacy"
    ? usedEdit && !usedEditRange && !usedWrite
    : usedEditRange && !usedEdit && !usedWrite;
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
  approach: Approach;
  prompt: string;
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
    writeText(join(artifactPath, "prompt.txt"), `${options.prompt}\n`),
    writeText(join(artifactPath, "stdout.txt"), options.processResult.stdout),
    writeText(join(artifactPath, "stderr.txt"), options.processResult.stderr),
    writeText(join(artifactPath, "config.yaml"), options.configYaml),
    writeText(join(artifactPath, "workspace.txt"), `${options.workspace}\n`),
    writeJson(join(artifactPath, "case.json"), {
      id: options.benchmarkCase.id,
      description: options.benchmarkCase.description,
      approach: options.approach,
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

async function runApproachOnce(
  benchmarkCase: BenchmarkCase,
  baseConfig: SloppyConfig,
  approach: Approach,
  run: number,
  options: CliOptions,
): Promise<BenchmarkRun> {
  const workspace = await mkdtemp(
    join(tmpdir(), `sloppy-headless-view-${benchmarkCase.id}-${approach}-`),
  );
  const metricsPath = join(workspace, ".sloppy/cli-metrics.json");
  const eventLogPath = join(workspace, ".sloppy/events.jsonl");
  const configYaml = buildBenchmarkConfig(baseConfig);
  const artifactPath = runArtifactPath(options.artifactDir, benchmarkCase, approach, run);
  const prompt = promptFor(benchmarkCase, approach);
  const started = performance.now();

  try {
    await writeWorkspace(workspace, benchmarkCase, configYaml);

    if (options.dryRun) {
      const validationResult = benchmarkCase.validate(benchmarkCase.files);
      return {
        caseId: benchmarkCase.id,
        caseDescription: benchmarkCase.description,
        approach,
        run,
        success: false,
        approachSatisfied: false,
        exitCode: 0,
        elapsedMs: 0,
        toolCalls: 0,
        toolCounts: {},
        editActions: [],
        stdoutChars: 0,
        stderrChars: 0,
        workspace: options.keepWorkspaces ? workspace : undefined,
        artifactPath,
        validation: validationResult,
        error: "dry_run",
      };
    }

    const proc = Bun.spawn({
      cmd: [process.execPath, "run", join(repoRoot, "src/cli.ts"), "-p", prompt],
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
    const validationResult = benchmarkCase.validate(finalFiles);
    const toolCounts = countTools(result.stdout);
    const actions = editActions(toolCounts);
    const satisfiesApproach = approachSatisfied(approach, actions);
    const success = !processError && result.exitCode === 0 && validationResult.ok && satisfiesApproach;
    const runResult: BenchmarkRun = {
      caseId: benchmarkCase.id,
      caseDescription: benchmarkCase.description,
      approach,
      run,
      success,
      approachSatisfied: satisfiesApproach,
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
      editActions: actions,
      stdoutChars: result.stdout.length,
      stderrChars: result.stderr.length,
      workspace: options.keepWorkspaces ? workspace : undefined,
      artifactPath,
      validation: validationResult,
      error: success
        ? undefined
        : processError ??
          metrics?.errorMessage ??
          (!satisfiesApproach ? "approach_not_satisfied" : undefined) ??
          result.stderr.split("\n").find((line) => line.includes("[error]")),
    };

    await writeRunArtifacts({
      artifactPath,
      benchmarkCase,
      approach,
      prompt,
      run,
      workspace,
      configYaml,
      metricsPath,
      eventLogPath,
      processResult: result,
      metrics,
      validation: validationResult,
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

function summarizeCaseApproach(runs: BenchmarkRun[], caseId: BenchmarkCaseId, approach: Approach) {
  const approachRuns = runs.filter((run) => run.caseId === caseId && run.approach === approach);
  return {
    case: caseId,
    approach,
    success: `${approachRuns.filter((run) => run.success).length}/${approachRuns.length}`,
    avgElapsedMs: average(approachRuns.map((run) => run.elapsedMs)),
    avgInputTokens: average(approachRuns.map((run) => run.inputTokens)),
    avgOutputTokens: average(approachRuns.map((run) => run.outputTokens)),
    avgStateContextTokens: average(approachRuns.map((run) => run.stateContextTokens)),
    avgModelCalls: average(approachRuns.map((run) => run.modelCalls)),
    avgToolCalls: average(approachRuns.map((run) => run.toolCalls)),
    editActions: [...new Set(approachRuns.flatMap((run) => run.editActions))].join(",") || "-",
  };
}

function printHuman(output: BenchmarkOutput, options: CliOptions): void {
  if (options.dryRun) {
    console.log("Headless source-view edit benchmark dry run");
    console.log(`Cases: ${options.caseIds.join(", ")}`);
    console.log(`Approaches: ${options.approaches.join(", ")}`);
    console.log(`Runs per approach: ${options.runs}`);
    console.log("");
    for (const caseId of options.caseIds) {
      const benchmarkCase = caseById(caseId);
      for (const approach of options.approaches) {
        console.log(`${benchmarkCase.id}/${approach}: ${benchmarkCase.description}`);
        console.log(promptFor(benchmarkCase, approach));
        console.log("");
      }
    }
    console.log(`Set ${LIVE_BENCHMARK_ENV}=1 to execute live LLM runs.`);
    return;
  }

  console.log(
    `Headless source-view edit live benchmark (${options.runs} run${options.runs === 1 ? "" : "s"}/case/approach)`,
  );
  if (output.artifactDir) {
    console.log(`Artifacts: ${output.artifactDir}`);
  }
  console.table(
    output.runs
      .map((run) => summarizeCaseApproach(output.runs, run.caseId, run.approach))
      .filter(
        (row, index, rows) =>
          rows.findIndex((item) => item.case === row.case && item.approach === row.approach) ===
          index,
      ),
  );

  const failed = output.runs.filter((run) => !run.success);
  if (failed.length > 0) {
    console.log("");
    console.log("Failures:");
    for (const run of failed) {
      console.log(
        `${run.caseId}/${run.approach}#${run.run}: exit=${run.exitCode} error=${run.error ?? "validation_failed"} validation=${JSON.stringify(run.validation)} artifact=${run.artifactPath ?? "-"}`,
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
      for (const approach of options.approaches) {
        runs.push(await runApproachOnce(benchmarkCase, baseConfig, approach, run, options));
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
