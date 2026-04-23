import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { defaultConfigPromise } from "../src/config/load";
import { Agent } from "../src/core/agent";

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
      writeFileSync(
        join(artifactDir, "orchestration-listing.txt"),
        readdirSync(orchestration, { recursive: true, withFileTypes: true })
          .map((e) => `${e.parentPath ?? ""}/${e.name}`)
          .join("\n"),
      );
    }
    if (existsSync(logPath)) {
      writeFileSync(join(artifactDir, "debug.log"), readFileSync(logPath, "utf8"));
    }
    process.stderr.write(`[e2e] artifacts saved to ${artifactDir}\n`);
  } catch {
    // best-effort
  }
}

async function buildOrchestratorConfig(root: string) {
  const baseConfig = await defaultConfigPromise;
  return {
    ...baseConfig,
    agent: { ...baseConfig.agent, orchestratorMode: true, maxIterations: 60 },
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
    5 * 60_000,
  );

  test(
    "orchestrator fans out to concurrent sub-agents and synthesizes a dependent task",
    async () => {
      const root = await setupWorkspace();
      const debugLog = join(root, "debug.log");
      const restoreStderr = redirectStderrTo(debugLog);

      const config = await buildOrchestratorConfig(root);
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
        const synthesizers = defs.filter((d) => d.depends_on.length >= 4);
        expect(synthesizers.length).toBeGreaterThanOrEqual(1);
        passed = true;
      } finally {
        agent.shutdown();
        restoreStderr();
        if (!passed) dumpArtifacts(root, debugLog, "e2e-fanout");
        await rm(root, { recursive: true, force: true });
      }
    },
    10 * 60_000,
  );
});

describe.if(!LIVE)("orchestration e2e (skipped)", () => {
  test("set SLOPPY_E2E_LLM=1 to run the live-LLM e2e tests", () => {
    expect(LIVE).toBe(false);
  });
});
