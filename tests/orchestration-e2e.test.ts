import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { defaultConfigPromise } from "../src/config/load";
import { Agent } from "../src/core/agent";

const LIVE = process.env.SLOPPY_E2E_LLM === "1";

const E2E_GOAL = [
  "Use the orchestration and delegation providers to complete this goal end-to-end.",
  "Goal: inside the workspace, first write a file `a.txt` containing exactly the text `HELLO`.",
  "Then read `a.txt` and write a file `b.txt` whose content is the text from `a.txt` reversed (so `OLLEH`).",
  "The second task must depend on the first so order is enforced.",
  "Create a plan, decompose into tasks with depends_on set correctly, spawn sub-agents, and complete the plan when done.",
].join(" ");

async function setupWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "sloppy-e2e-"));
  mkdirSync(join(root, ".sloppy/orchestration"), { recursive: true });
  return root;
}

function dumpArtifacts(root: string, logPath: string): void {
  try {
    const artifactDir = resolve("test-artifacts", `e2e-${Date.now()}`);
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

describe.if(LIVE)("orchestration e2e (live LLM)", () => {
  test(
    "orchestrator decomposes, delegates, and completes a dependency-ordered plan",
    async () => {
      const root = await setupWorkspace();
      const debugLog = join(root, "debug.log");
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: unknown) => {
        try {
          writeFileSync(debugLog, String(chunk), { flag: "a" });
        } catch {
          // ignore
        }
        return originalWrite(chunk as never);
      }) as typeof process.stderr.write;

      const baseConfig = await defaultConfigPromise;
      const config = {
        ...baseConfig,
        agent: { ...baseConfig.agent, orchestratorMode: true, maxIterations: 40 },
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

      const agent = new Agent({ config });
      let passed = false;
      try {
        await agent.start();
        const result = await agent.chat(E2E_GOAL);
        expect(result.status).toBe("completed");

        const aPath = join(root, "a.txt");
        const bPath = join(root, "b.txt");
        expect(existsSync(aPath)).toBe(true);
        expect(existsSync(bPath)).toBe(true);
        expect(readFileSync(aPath, "utf8").trim()).toBe("HELLO");
        expect(readFileSync(bPath, "utf8").trim()).toBe("OLLEH");

        const planPath = join(root, ".sloppy/orchestration/plan.json");
        expect(existsSync(planPath)).toBe(true);
        const plan = JSON.parse(readFileSync(planPath, "utf8"));
        expect(plan.status).toBe("completed");

        const tasksDir = join(root, ".sloppy/orchestration/tasks");
        const taskIds = readdirSync(tasksDir).filter((n) =>
          existsSync(join(tasksDir, n, "definition.json")),
        );
        expect(taskIds.length).toBeGreaterThanOrEqual(2);
        const withDeps = taskIds.filter((id) => {
          const def = JSON.parse(
            readFileSync(join(tasksDir, id, "definition.json"), "utf8"),
          );
          return Array.isArray(def.depends_on) && def.depends_on.length > 0;
        });
        expect(withDeps.length).toBeGreaterThanOrEqual(1);
        passed = true;
      } finally {
        agent.shutdown();
        process.stderr.write = originalWrite;
        if (!passed) dumpArtifacts(root, debugLog);
        await rm(root, { recursive: true, force: true });
      }
    },
    5 * 60_000,
  );
});

describe.if(!LIVE)("orchestration e2e (skipped)", () => {
  test("set SLOPPY_E2E_LLM=1 to run the live-LLM e2e test", () => {
    expect(LIVE).toBe(false);
  });
});
