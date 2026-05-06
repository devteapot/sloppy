import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliSessionAgent } from "../src/runtime/cli";

async function writeScript(workspaceRoot: string, name: string, source: string): Promise<string> {
  const scriptPath = join(workspaceRoot, name);
  await writeFile(scriptPath, source);
  return scriptPath;
}

describe("CliSessionAgent", () => {
  test("runs a prompt through a subprocess and streams stdout", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-cli-agent-"));
    try {
      const script = await writeScript(
        workspaceRoot,
        "agent.mjs",
        `
const prompt = process.argv.slice(2).join(" ");
process.stdout.write("hello ");
process.stdout.write(prompt);
`,
      );
      let streamed = "";
      const agent = new CliSessionAgent({
        adapterId: "fake",
        adapter: {
          command: ["node", script],
        },
        callbacks: {
          onText: (chunk) => {
            streamed += chunk;
          },
        },
        workspaceRoot,
      });

      const result = await agent.chat("from cli");

      expect(result).toEqual({ status: "completed", response: "hello from cli" });
      expect(streamed).toBe("hello from cli");
      agent.shutdown();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("fails with stderr when a subprocess exits non-zero", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-cli-agent-fail-"));
    try {
      const script = await writeScript(
        workspaceRoot,
        "agent.mjs",
        `
process.stderr.write("nope");
process.exit(7);
`,
      );
      const agent = new CliSessionAgent({
        adapterId: "bad",
        adapter: {
          command: ["node", script],
        },
        callbacks: {},
        workspaceRoot,
      });

      await expect(agent.chat("ignored")).rejects.toThrow(
        "CLI adapter 'bad' exited with code 7. stderr: nope",
      );
      agent.shutdown();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("expands model placeholders for external model profiles", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-cli-agent-model-"));
    try {
      const script = await writeScript(
        workspaceRoot,
        "agent.mjs",
        `
const [model, prompt] = process.argv.slice(2);
process.stdout.write(model + ":" + prompt);
`,
      );
      const agent = new CliSessionAgent({
        adapterId: "codex",
        adapter: {
          command: ["node", script, "{model}", "{prompt}"],
        },
        modelOverride: "gpt-5.5",
        callbacks: {},
        workspaceRoot,
      });

      const result = await agent.chat("from cli");

      expect(result).toEqual({ status: "completed", response: "gpt-5.5:from cli" });
      agent.shutdown();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
