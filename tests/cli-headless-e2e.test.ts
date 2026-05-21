import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LIVE_E2E_ENV = "SLOPPY_RUN_LIVE_E2E";
const runLiveE2E = Bun.env[LIVE_E2E_ENV] === "1";
const liveTest = runLiveE2E ? test : test.skip;
const timeoutMs = Number.parseInt(Bun.env.SLOPPY_HEADLESS_E2E_TIMEOUT_MS ?? "180000", 10);

type SpawnedProcess = {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(): void;
};

type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function collectProcess(
  proc: SpawnedProcess,
  options: { timeoutMs: number },
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
      reject(new Error(`headless CLI e2e timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
  });

  try {
    return await Promise.race([output, deadline]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

describe("CLI headless live e2e", () => {
  liveTest(
    "runs `-p` through the real runtime, configured LLM, and filesystem provider",
    async () => {
      const id = randomUUID();
      const marker = `SLOPPY_HEADLESS_E2E_${id.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
      const relativeDir = join("test-artifacts", "headless-e2e", id);
      const relativeFile = join(relativeDir, "marker.txt");
      const artifactDir = join(process.cwd(), relativeDir);
      const eventLogPath = join(artifactDir, "events.jsonl");

      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(process.cwd(), relativeFile), `${marker}\n`);

      try {
        const prompt = [
          `Use the filesystem provider to read ${relativeFile}.`,
          "Return only the exact file contents.",
          "If the first visible token in this user message is a command-line option, return BAD_FLAG instead.",
          "Do not use the terminal and do not write files.",
        ].join(" ");
        const proc = Bun.spawn({
          cmd: [process.execPath, "run", join(process.cwd(), "src/cli.ts"), "-p", prompt],
          cwd: process.cwd(),
          env: {
            ...process.env,
            SLOPPY_MAX_ITERATIONS: process.env.SLOPPY_MAX_ITERATIONS ?? "6",
            SLOPPY_EVENT_LOG: eventLogPath,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const result = await collectProcess(proc, { timeoutMs });

        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stderr).toContain("[sloppy] providers:");
        expect(result.stdout).toContain(marker);
        expect(result.stdout).not.toContain("BAD_FLAG");

        const records = (await readFile(eventLogPath, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { kind?: string; providerId?: string });
        expect(
          records.some(
            (record) => record.kind === "tool_started" && record.providerId === "filesystem",
          ),
        ).toBe(true);
        expect(
          records.some(
            (record) => record.kind === "tool_completed" && record.providerId === "filesystem",
          ),
        ).toBe(true);
      } finally {
        await rm(artifactDir, { recursive: true, force: true });
      }
    },
    timeoutMs + 5000,
  );
});
