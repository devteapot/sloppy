import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SloppyConfig } from "../src/config/schema";
import { runRuntimeDoctor } from "../src/runtime/doctor-runner";

const originalFetch = globalThis.fetch;
const originalLiteLlmKey = process.env.LITELLM_API_KEY;

const TEST_CONFIG: SloppyConfig = {
  llm: {
    provider: "openai",
    model: "gpt-5.4",
    profiles: [],
    maxTokens: 4096,
  },
  agent: {
    maxIterations: 4,
    contextBudgetTokens: 24000,
    minSalience: 0.2,
    overviewDepth: 2,
    overviewMaxNodes: 200,
    detailDepth: 4,
    detailMaxNodes: 200,
    historyTurns: 8,
    toolResultMaxChars: 16000,
  },
  maxToolResultSize: 4096,
  providers: {
    builtin: {
      terminal: false,
      filesystem: false,
      memory: false,
      skills: false,
      metaRuntime: false,
      web: false,
      browser: false,
      cron: false,
      messaging: false,
      delegation: false,
      spec: false,
      vision: false,
    },
    discovery: { enabled: false, paths: [] },
    terminal: { cwd: ".", historyLimit: 10, syncTimeoutMs: 30000 },
    filesystem: {
      root: ".",
      focus: ".",
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
      contentRefThresholdBytes: 8192,
      previewBytes: 2048,
    },
    memory: { maxMemories: 500, defaultWeight: 0.5, compactThreshold: 0.2 },
    skills: { skillsDir: "~/.sloppy/skills" },
    web: { historyLimit: 20 },
    browser: { viewportWidth: 1280, viewportHeight: 720 },
    cron: { maxJobs: 50 },
    messaging: { maxMessages: 500 },
    delegation: {
      maxAgents: 10,
    },
    metaRuntime: {
      globalRoot: "~/.sloppy/meta-runtime",
      workspaceRoot: ".sloppy/meta-runtime",
    },
    vision: { maxImages: 50, defaultWidth: 512, defaultHeight: 512 },
  },
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLiteLlmKey == null) {
    delete process.env.LITELLM_API_KEY;
  } else {
    process.env.LITELLM_API_KEY = originalLiteLlmKey;
  }
});

describe("runtime doctor", () => {
  test("reports skipped optional checks when no ACP adapter is requested", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-"));
    try {
      const result = await runRuntimeDoctor({
        config: TEST_CONFIG,
        workspaceRoot,
      });

      expect(result.workspaceRoot).toBe(workspaceRoot);
      expect(result.checks).toContainEqual({
        id: "litellm",
        status: "skipped",
        summary: "No OpenAI-compatible base URL provided.",
      });
      expect(result.checks).toContainEqual({
        id: "acp",
        status: "skipped",
        summary: "No ACP adapter id provided.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("checks the configured OpenAI-compatible base URL with the configured API key env", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-url-"));
    const seenHeaders: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers);
      seenHeaders.push(headers.get("authorization") ?? "");
      return new Response(JSON.stringify({ data: [{ id: "local-model" }] }), {
        status: 200,
      });
    }) as typeof fetch;
    process.env.LITELLM_API_KEY = "router-key";

    try {
      const result = await runRuntimeDoctor({
        config: {
          ...TEST_CONFIG,
          llm: {
            ...TEST_CONFIG.llm,
            apiKeyEnv: "LITELLM_API_KEY",
            baseUrl: "http://sloppy-mba.local:8001/v1",
          },
        },
        workspaceRoot,
      });

      expect(seenHeaders).toEqual(["Bearer router-key"]);
      expect(result.checks).toContainEqual({
        id: "litellm",
        status: "ok",
        summary:
          "Router responded at http://sloppy-mba.local:8001/v1/models using LITELLM_API_KEY.",
        detail: JSON.stringify({ data: [{ id: "local-model" }] }),
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("does not treat native OpenAI Codex base URL as an OpenAI-compatible router", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-codex-"));
    const fetchCalls: string[] = [];
    globalThis.fetch = (async (input) => {
      fetchCalls.push(String(input));
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    try {
      const result = await runRuntimeDoctor({
        config: {
          ...TEST_CONFIG,
          llm: {
            ...TEST_CONFIG.llm,
            provider: "openai-codex",
            model: "gpt-5.5",
            baseUrl: "https://chatgpt.com/backend-api/codex",
          },
        },
        workspaceRoot,
      });

      expect(fetchCalls).toEqual([]);
      expect(result.checks).toContainEqual({
        id: "litellm",
        status: "skipped",
        summary: "No OpenAI-compatible base URL provided.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("warns when a requested ACP adapter weakens the process boundary", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-acp-boundary-"));
    try {
      const result = await runRuntimeDoctor({
        config: {
          ...TEST_CONFIG,
          providers: {
            ...TEST_CONFIG.providers,
            delegation: {
              maxAgents: 10,
              acp: {
                enabled: true,
                adapters: {
                  unsafe: {
                    command: ["node", "-e", "process.exit(1)"],
                    inheritEnv: true,
                  },
                },
              },
            },
          },
        },
        workspaceRoot,
        acpAdapterId: "unsafe",
        timeoutMs: 100,
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({
          id: "acp-boundary",
          status: "warning",
          summary: expect.stringContaining("inherits the full Sloppy process environment"),
        }),
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
