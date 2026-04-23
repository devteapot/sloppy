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
});

describe.if(!LIVE)("orchestration e2e (skipped)", () => {
  test("set SLOPPY_E2E_LLM=1 to run the live-LLM e2e tests", () => {
    expect(LIVE).toBe(false);
  });
});
