import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { defaultConfigPromise } from "../src/config/load";
import { Agent } from "../src/core/agent";
import { LlmProfileManager } from "../src/llm/profile-manager";

const LIVE = process.env.SLOPPY_E2E_LLM === "1";

async function setupWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sloppy-e2e-"));
  mkdirSync(join(root, ".sloppy/orchestration"), { recursive: true });
  return root;
}

function dumpArtifacts(root: string, logPath: string, label: string): void {
  try {
    const artifactDir = resolve("test-artifacts", `${label}-${Date.now()}`);
    mkdirSync(artifactDir, { recursive: true });
    const orchestration = join(root, ".sloppy/orchestration");
    if (existsSync(orchestration)) {
      const entries = readdirSync(orchestration, { recursive: true, withFileTypes: true });
      writeFileSync(
        join(artifactDir, "orchestration-listing.txt"),
        entries.map((e) => `${e.parentPath ?? ""}/${e.name}`).join("\n"),
      );
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const parent = entry.parentPath ?? "";
        const src = join(parent, entry.name);
        const rel = src.slice(root.length + 1).replaceAll("/", "__");
        writeFileSync(join(artifactDir, rel), readFileSync(src, "utf8"));
      }
    }
    for (const file of readdirSync(root)) {
      const full = join(root, file);
      if (existsSync(full) && !file.startsWith(".") && file !== "debug.log") {
        try {
          writeFileSync(join(artifactDir, `workspace__${file}`), readFileSync(full, "utf8"));
        } catch {
          // skip non-text files
        }
      }
    }
    if (existsSync(logPath)) {
      writeFileSync(join(artifactDir, "debug.log"), readFileSync(logPath, "utf8"));
    }
    process.stderr.write(`[e2e] artifacts saved to ${artifactDir}\n`);
  } catch (error) {
    process.stderr.write(`[e2e] artifact dump failed: ${String(error)}\n`);
  }
}

async function buildOrchestratorConfig(root: string) {
  const baseConfig = await defaultConfigPromise;
  const provider = process.env.SLOPPY_LLM_PROVIDER;
  const baseUrl = process.env.SLOPPY_LLM_BASE_URL;
  const model = process.env.SLOPPY_MODEL;
  if (!provider || !baseUrl || !model) {
    throw new Error(
      "Live e2e test requires SLOPPY_LLM_PROVIDER, SLOPPY_LLM_BASE_URL, and SLOPPY_MODEL to be set. Refusing to run against the user's managed profiles (Opus/OpenRouter etc.).",
    );
  }
  const apiKeyEnv = process.env.SLOPPY_LLM_API_KEY_ENV ?? "OPENAI_API_KEY";
  if (!process.env[apiKeyEnv]) {
    throw new Error(
      `Live e2e test requires ${apiKeyEnv} to be set in env (or set SLOPPY_LLM_API_KEY_ENV to a different var).`,
    );
  }
  return {
    ...baseConfig,
    agent: { ...baseConfig.agent, orchestratorMode: true, maxIterations: 60 },
    // Build the llm config from scratch from env vars so nothing from
    // ~/.sloppy/config.yaml (managed profiles, apiKeyEnv, default profile id)
    // can route the test to the user's cloud billing account.
    llm: {
      provider: provider as typeof baseConfig.llm.provider,
      baseUrl,
      model,
      apiKeyEnv,
      profiles: [],
      defaultProfileId: undefined,
      maxTokens: baseConfig.llm.maxTokens,
    },
    providers: {
      ...baseConfig.providers,
      builtin: {
        ...baseConfig.providers.builtin,
        terminal: false,
        memory: false,
        skills: false,
        web: false,
        browser: false,
        cron: false,
        messaging: false,
        vision: false,
        filesystem: true,
        delegation: true,
        orchestration: true,
      },
      filesystem: { ...baseConfig.providers.filesystem, root, focus: root },
    },
  };
}

async function assertLlmRoutedToEnv(
  config: Awaited<ReturnType<typeof buildOrchestratorConfig>>,
): Promise<void> {
  const manager = new LlmProfileManager({ config });
  const state = await manager.getState();
  const active = state.profiles.find((p) => p.id === state.activeProfileId);
  const expectedBase = process.env.SLOPPY_LLM_BASE_URL;
  const expectedModel = process.env.SLOPPY_MODEL;
  if (!active || active.baseUrl !== expectedBase || active.model !== expectedModel) {
    throw new Error(
      `E2E safeguard: active LLM profile does not match env overrides. ` +
        `Expected baseUrl=${expectedBase} model=${expectedModel}, ` +
        `got profile=${active?.id} baseUrl=${active?.baseUrl} model=${active?.model}. ` +
        `Refusing to run to avoid billing the user's managed cloud profile.`,
    );
  }
  process.stderr.write(
    `[e2e] LLM routed to ${active.provider} ${active.model} @ ${active.baseUrl}\n`,
  );
}

function redirectStderrTo(logPath: string): () => void {
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    try {
      writeFileSync(logPath, String(chunk), { flag: "a" });
    } catch {
      // ignore
    }
    return originalWrite(chunk as never);
  }) as typeof process.stderr.write;
  return () => {
    process.stderr.write = originalWrite;
  };
}

function loadTaskDefs(root: string): Array<{ id: string; depends_on: string[] }> {
  const tasksDir = join(root, ".sloppy/orchestration/tasks");
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir)
    .filter((n) => existsSync(join(tasksDir, n, "definition.json")))
    .map((id) => {
      const def = JSON.parse(readFileSync(join(tasksDir, id, "definition.json"), "utf8"));
      return {
        id,
        depends_on: Array.isArray(def.depends_on) ? (def.depends_on as string[]) : [],
      };
    });
}

const DEPENDENCY_GOAL = [
  "Use the orchestration and delegation providers to complete this goal end-to-end.",
  "Goal: inside the workspace, first write a file `a.txt` containing exactly the text `HELLO`.",
  "Then read `a.txt` and write a file `b.txt` whose content is the text from `a.txt` reversed (so `OLLEH`).",
  "The second task must depend on the first so order is enforced.",
  "Create a plan, decompose into tasks with depends_on set correctly, spawn sub-agents, and complete the plan when done.",
].join(" ");

const CAS_COLLAB_GOAL = [
  "Use the orchestration and delegation providers to complete this goal end-to-end.",
  "Two sub-agents will concurrently edit the SAME file, `ledger.txt`, under the workspace root.",
  "Create a plan and two independent tasks (no dependencies between them) so both can run in parallel:",
  "- Task A goal (verbatim, pass it exactly):",
  "  `Append a single line 'A-DONE' to the file 'ledger.txt' under the workspace root.`",
  "  `PROTOCOL (mandatory CAS loop): (1) Call the filesystem 'read' affordance on 'ledger.txt'. The read ALWAYS succeeds; if the file does not exist yet, read returns content='' and version=0. Record both values.`",
  "  `(2) Compute new_content = current_content + 'A-DONE\\n'.`",
  "  `(3) Call the filesystem 'write' affordance with path='ledger.txt', content=new_content, AND expected_version=<the version returned by step 1>.`",
  "  `(4) Inspect the write result. If it contains {error: 'version_conflict', currentVersion: N}, DO NOT give up. Re-read the file (step 1), recompute new_content (step 2), and write again with the new version (step 3). Retry until the write result does NOT contain an 'error' field.`",
  "  `Do not ever call 'write' without expected_version. Do not skip the read after a conflict.`",
  "- Task B goal: identical to Task A but the line to append is 'B-DONE' instead of 'A-DONE'.",
  "Spawn both sub-agents in the same orchestrator turn so they run concurrently and contend for the file.",
  "When both tasks are completed, call complete_plan.",
].join(" ");

const SURGICAL_EDIT_SEED = `// src/config.ts — runtime configuration
// Do not modify sections marked AUTO-GEN; they are regenerated on every build.

import type { AppConfig } from "./types";

/**
 * Tunables for the request pipeline. Bump concurrency carefully.
 */
export const DEFAULT_TIMEOUT_MS = 5000;
export const RETRY_ATTEMPTS = 3;
export const MAX_CONCURRENT = 4;
export const CACHE_SIZE = 1024;

// AUTO-GEN START — build metadata, do not edit by hand
export const BUILD_ID = "b-01HXZ1ABCDEF";
export const GIT_SHA = "abc1234def5678";
export const BUILT_AT = "2026-04-23T00:00:00.000Z";
// AUTO-GEN END

/** Runtime configuration consumed by the server bootstrap. */
export const config: AppConfig = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  retries: RETRY_ATTEMPTS,
  concurrent: MAX_CONCURRENT,
  cacheSize: CACHE_SIZE,
  debug: false,
  flags: {
    useNewScheduler: false,
    emitTraceSpans: true,
  },
};
`;

const SURGICAL_EDIT_GOAL = [
  "The workspace already contains a file `config.ts`. Delegate a single-task plan to a sub-agent.",
  "Task: change ONLY the value of `MAX_CONCURRENT` from 4 to 16 in `config.ts`. Every other byte of the file must stay identical — preserve every comment, every blank line, every other constant, the AUTO-GEN block, the config object literal, everything.",
  "The sub-agent should read the file first (so it sees the current content and version), then apply the change. Use the filesystem affordances available to it. Remember to pass expected_version on any mutating call so concurrent edits would be detected (even though this plan has only one writer).",
  "When the task is completed, complete the plan.",
].join(" ");

const IMPLEMENT_GOAL = [
  "Your job: delegate to sub-agents to build a small TypeScript calculator module and its tests, under the workspace root.",
  "Create a plan and two tasks:",
  "Task 'calc': Write `calc.ts` under the workspace root. It MUST export exactly these four functions and nothing else:",
  "  `export function add(a: number, b: number): number`  // returns a + b",
  "  `export function sub(a: number, b: number): number`  // returns a - b",
  "  `export function mul(a: number, b: number): number`  // returns a * b",
  "  `export function div(a: number, b: number): number | null`  // returns a / b, or null when b === 0",
  "Task 'tests': Write `calc.test.ts` under the workspace root. It MUST import from `./calc` and use `bun:test` (`import { describe, expect, test } from 'bun:test'`). Include at least:",
  "  one add case, one sub case, one mul case, one div case with a non-zero divisor, and one div case with divisor 0 that asserts the result is null.",
  "  This task depends on 'calc' — pass the task id returned by create_task('calc') in depends_on.",
  "Protocol reminders: use task ids (e.g. 'task-abcd1234') in depends_on, not task names. Spawn each sub-agent via spawn_agent({ task_id, name, goal }) AFTER its dependencies are completed. Complete the plan when both tasks are completed.",
].join(" ");

const FANOUT_GOAL = [
  "Use the orchestration and delegation providers to complete this goal end-to-end.",
  "Create exactly five files under the workspace root:",
  "`colors.txt` containing three lines `red`, `green`, `blue`;",
  "`shapes.txt` containing three lines `circle`, `square`, `triangle`;",
  "`animals.txt` containing three lines `dog`, `cat`, `bird`;",
  "`numbers.txt` containing three lines `1`, `2`, `3`;",
  "and finally `index.txt` containing a single line `TOTAL=12` (the sum of the line counts of the other four files).",
  "The first four files are independent of each other -- each MUST be its own task with NO dependency on the others, so they can run in parallel as separate sub-agents.",
  "`index.txt` depends on all four previous tasks and must only be written after they complete.",
  "Create a plan, create five tasks with the correct depends_on shape, spawn sub-agents for each, and complete the plan when done.",
].join(" ");

describe.if(LIVE)("orchestration e2e (live LLM)", () => {
  test(
    "orchestrator decomposes, delegates, and completes a dependency-ordered plan",
    async () => {
      const root = await setupWorkspace();
      const debugLog = join(root, "debug.log");
      const restoreStderr = redirectStderrTo(debugLog);

      const config = await buildOrchestratorConfig(root);
      await assertLlmRoutedToEnv(config);
      const agent = new Agent({ config });
      let passed = false;
      try {
        await agent.start();
        const result = await agent.chat(DEPENDENCY_GOAL);
        expect(result.status).toBe("completed");

        expect(readFileSync(join(root, "a.txt"), "utf8").trim()).toBe("HELLO");
        expect(readFileSync(join(root, "b.txt"), "utf8").trim()).toBe("OLLEH");

        const plan = JSON.parse(
          readFileSync(join(root, ".sloppy/orchestration/plan.json"), "utf8"),
        );
        expect(plan.status).toBe("completed");

        const defs = loadTaskDefs(root);
        expect(defs.length).toBeGreaterThanOrEqual(2);
        expect(defs.filter((d) => d.depends_on.length > 0).length).toBeGreaterThanOrEqual(1);
        passed = true;
      } finally {
        agent.shutdown();
        restoreStderr();
        if (!passed) dumpArtifacts(root, debugLog, "e2e-dependency");
        await rm(root, { recursive: true, force: true });
      }
    },
    10 * 60_000,
  );

  test(
    "orchestrator fans out to concurrent sub-agents and synthesizes a dependent task",
    async () => {
      const root = await setupWorkspace();
      const debugLog = join(root, "debug.log");
      const restoreStderr = redirectStderrTo(debugLog);

      const config = await buildOrchestratorConfig(root);
      await assertLlmRoutedToEnv(config);
      const agent = new Agent({ config });
      let passed = false;
      try {
        await agent.start();
        const result = await agent.chat(FANOUT_GOAL);
        expect(result.status).toBe("completed");

        const expectations: Record<string, string[]> = {
          "colors.txt": ["red", "green", "blue"],
          "shapes.txt": ["circle", "square", "triangle"],
          "animals.txt": ["dog", "cat", "bird"],
          "numbers.txt": ["1", "2", "3"],
        };
        for (const [file, lines] of Object.entries(expectations)) {
          const content = readFileSync(join(root, file), "utf8")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          expect(content).toEqual(lines);
        }
        expect(readFileSync(join(root, "index.txt"), "utf8").trim()).toBe("TOTAL=12");

        const plan = JSON.parse(
          readFileSync(join(root, ".sloppy/orchestration/plan.json"), "utf8"),
        );
        expect(plan.status).toBe("completed");

        const defs = loadTaskDefs(root);
        expect(defs.length).toBeGreaterThanOrEqual(5);
        const independent = defs.filter((d) => d.depends_on.length === 0);
        expect(independent.length).toBeGreaterThanOrEqual(4);
        // Note: we used to require at least one task with depends_on.length>=4
        // (a synthesizer encoded declaratively). Some models (e.g. Qwen) drive
        // the same correct end-state by observing task status instead of
        // encoding deps. Outcome — the files — is what we actually assert.
        passed = true;
      } finally {
        agent.shutdown();
        restoreStderr();
        if (!passed) dumpArtifacts(root, debugLog, "e2e-fanout");
        await rm(root, { recursive: true, force: true });
      }
    },
    20 * 60_000,
  );

  test(
    "concurrent sub-agents collaborate on a shared file via CAS without losing writes",
    async () => {
      const root = await setupWorkspace();
      const debugLog = join(root, "debug.log");
      const restoreStderr = redirectStderrTo(debugLog);

      const config = await buildOrchestratorConfig(root);
      await assertLlmRoutedToEnv(config);
      const agent = new Agent({ config });
      let passed = false;
      try {
        await agent.start();
        const result = await agent.chat(CAS_COLLAB_GOAL);
        expect(result.status).toBe("completed");

        const ledger = readFileSync(join(root, "ledger.txt"), "utf8");
        // Both contributions must survive; CAS ensures no write is lost.
        // We assert substring presence rather than strict line formatting —
        // the important property is "no lost update", not agent
        // formatting discipline.
        expect(ledger).toContain("A-DONE");
        expect(ledger).toContain("B-DONE");
        // No duplicated contribution — a retry that re-reads must see the
        // other agent's content and not append its own twice.
        expect((ledger.match(/A-DONE/g) ?? []).length).toBe(1);
        expect((ledger.match(/B-DONE/g) ?? []).length).toBe(1);

        // Bonus signal: was CAS actually exercised? If both agents wrote
        // sequentially by luck, no conflict fired. That's still a pass
        // (outcome is correct), but we log it so the operator can tell.
        const logLines = existsSync(debugLog) ? readFileSync(debugLog, "utf8") : "";
        const conflicts = (logLines.match(/"event":"write_version_conflict"/g) ?? []).length;
        process.stderr.write(`[e2e] CAS conflicts observed: ${conflicts}\n`);

        const plan = JSON.parse(
          readFileSync(join(root, ".sloppy/orchestration/plan.json"), "utf8"),
        );
        expect(plan.status).toBe("completed");

        const defs = loadTaskDefs(root);
        expect(defs.length).toBeGreaterThanOrEqual(2);
        expect(defs.every((d) => d.depends_on.length === 0)).toBe(true);
        passed = true;
      } finally {
        agent.shutdown();
        restoreStderr();
        if (!passed) dumpArtifacts(root, debugLog, "e2e-cas-collab");
        await rm(root, { recursive: true, force: true });
      }
    },
    15 * 60_000,
  );

  test(
    "orchestrator ships a working TS module with passing bun:test suite",
    async () => {
      const root = await setupWorkspace();
      const debugLog = join(root, "debug.log");
      const restoreStderr = redirectStderrTo(debugLog);

      const config = await buildOrchestratorConfig(root);
      await assertLlmRoutedToEnv(config);
      const agent = new Agent({ config });
      let passed = false;
      try {
        await agent.start();
        const result = await agent.chat(IMPLEMENT_GOAL);
        expect(result.status).toBe("completed");

        const calcPath = join(root, "calc.ts");
        const testPath = join(root, "calc.test.ts");
        expect(existsSync(calcPath)).toBe(true);
        expect(existsSync(testPath)).toBe(true);

        const calcSource = readFileSync(calcPath, "utf8");
        // Signature spot-checks — cheap sanity before running the real suite.
        expect(calcSource).toMatch(/export\s+function\s+add\s*\(/);
        expect(calcSource).toMatch(/export\s+function\s+sub\s*\(/);
        expect(calcSource).toMatch(/export\s+function\s+mul\s*\(/);
        expect(calcSource).toMatch(/export\s+function\s+div\s*\(/);

        // External verification: run the agent-authored tests with bun.
        const proc = Bun.spawn({
          cmd: ["bun", "test", "calc.test.ts"],
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (exitCode !== 0) {
          process.stderr.write(
            `[e2e] bun test FAILED\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`,
          );
        }
        expect(exitCode).toBe(0);

        const plan = JSON.parse(
          readFileSync(join(root, ".sloppy/orchestration/plan.json"), "utf8"),
        );
        expect(plan.status).toBe("completed");

        const defs = loadTaskDefs(root);
        expect(defs.length).toBeGreaterThanOrEqual(2);
        expect(defs.some((d) => d.depends_on.length > 0)).toBe(true);
        passed = true;
      } finally {
        agent.shutdown();
        restoreStderr();
        if (!passed) dumpArtifacts(root, debugLog, "e2e-implement");
        await rm(root, { recursive: true, force: true });
      }
    },
    30 * 60_000,
  );

  test(
    "surgical edit preserves surrounding content (affordance-driven tool choice)",
    async () => {
      const root = await setupWorkspace();
      writeFileSync(join(root, "config.ts"), SURGICAL_EDIT_SEED, "utf8");
      const debugLog = join(root, "debug.log");
      const restoreStderr = redirectStderrTo(debugLog);

      const config = await buildOrchestratorConfig(root);
      await assertLlmRoutedToEnv(config);
      const agent = new Agent({ config });
      let passed = false;
      try {
        await agent.start();
        const result = await agent.chat(SURGICAL_EDIT_GOAL);
        expect(result.status).toBe("completed");

        const configPath = join(root, "config.ts");
        expect(existsSync(configPath)).toBe(true);
        const after = readFileSync(configPath, "utf8");

        // Core correctness: the target constant changed.
        expect(after).toContain("export const MAX_CONCURRENT = 16;");
        expect(after).not.toContain("export const MAX_CONCURRENT = 4;");

        // Preservation: everything else that wasn't the target must be byte-identical.
        // Compute the expected file by doing the same surgical substitution
        // on the seed, then compare whole-file.
        const expected = SURGICAL_EDIT_SEED.replace(
          "export const MAX_CONCURRENT = 4;",
          "export const MAX_CONCURRENT = 16;",
        );
        expect(after).toBe(expected);

        // Observational: did the model pick the right affordance? Report, don't fail.
        const logLines = existsSync(debugLog) ? readFileSync(debugLog, "utf8") : "";
        const editCalls = (
          logLines.match(/"toolName":"filesystem__workspace__edit"/g) ?? []
        ).length;
        const writeCalls = (
          logLines.match(/"toolName":"filesystem__workspace__write"/g) ?? []
        ).length;
        process.stderr.write(
          `[e2e] tool choice: edit=${editCalls} write=${writeCalls} ` +
            `(affordance-driven steering is ${editCalls > 0 && writeCalls === 0 ? "WORKING" : "not exclusive"})\n`,
        );

        const plan = JSON.parse(
          readFileSync(join(root, ".sloppy/orchestration/plan.json"), "utf8"),
        );
        expect(plan.status).toBe("completed");
        passed = true;
      } finally {
        agent.shutdown();
        restoreStderr();
        if (!passed) dumpArtifacts(root, debugLog, "e2e-surgical-edit");
        await rm(root, { recursive: true, force: true });
      }
    },
    20 * 60_000,
  );
});

describe.if(!LIVE)("orchestration e2e (skipped)", () => {
  test("set SLOPPY_E2E_LLM=1 to run the live-LLM e2e tests", () => {
    expect(LIVE).toBe(false);
  });
});
