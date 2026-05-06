import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSlopServer } from "@slop-ai/server";
import { listenUnix } from "@slop-ai/server/unix";

import type { SloppyConfig } from "../src/config/schema";
import type { CredentialStore, CredentialStoreStatus } from "../src/llm/credential-store";
import { runRuntimeDoctor } from "../src/runtime/doctor-runner";

const originalFetch = globalThis.fetch;
const originalLiteLlmKey = process.env.LITELLM_API_KEY;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalEventLog = process.env.SLOPPY_EVENT_LOG;

class MemoryCredentialStore implements CredentialStore {
  readonly kind = "keychain" as const;

  constructor(
    private status: CredentialStoreStatus = "available",
    private secrets = new Map<string, string>(),
  ) {}

  async getStatus(): Promise<CredentialStoreStatus> {
    return this.status;
  }

  async get(profileId: string): Promise<string | null> {
    return this.secrets.get(profileId) ?? null;
  }

  async set(profileId: string, secret: string): Promise<void> {
    this.secrets.set(profileId, secret);
  }

  async delete(profileId: string): Promise<void> {
    this.secrets.delete(profileId);
  }
}

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
  if (originalOpenAiKey == null) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
  if (originalEventLog == null) {
    delete process.env.SLOPPY_EVENT_LOG;
  } else {
    process.env.SLOPPY_EVENT_LOG = originalEventLog;
  }
});

describe("runtime doctor", () => {
  test("reports skipped optional checks when no ACP adapter is requested", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-"));
    delete process.env.SLOPPY_EVENT_LOG;
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
      expect(result.checks).toContainEqual({
        id: "audit-log",
        status: "skipped",
        summary: "No runtime audit log path configured.",
      });
      expect(result.checks).toContainEqual({
        id: "session-socket",
        status: "skipped",
        summary: "No session or supervisor socket path provided.",
      });
      expect(result.checks).toContainEqual({
        id: "workspace-paths",
        status: "ok",
        summary: `Filesystem root is usable at ${workspaceRoot}.`,
      });
      expect(result.checks).toContainEqual({
        id: "subprocess-commands",
        status: "skipped",
        summary: "No startup subprocess commands are configured.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("checks configured runtime audit log writability", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-audit-"));
    const eventLogPath = join(workspaceRoot, "logs/events.jsonl");

    try {
      const result = await runRuntimeDoctor({
        config: TEST_CONFIG,
        workspaceRoot,
        eventLogPath,
        credentialStore: new MemoryCredentialStore("unavailable"),
      });

      expect(result.checks).toContainEqual({
        id: "audit-log",
        status: "ok",
        summary: `Runtime audit log is writable at ${eventLogPath}.`,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("reports unwritable runtime audit log paths", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-audit-bad-"));
    const blocker = join(workspaceRoot, "not-a-dir");
    await writeFile(blocker, "file blocks directory creation", "utf8");

    try {
      const result = await runRuntimeDoctor({
        config: TEST_CONFIG,
        workspaceRoot,
        eventLogPath: join(blocker, "events.jsonl"),
        credentialStore: new MemoryCredentialStore("unavailable"),
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({
          id: "audit-log",
          status: "error",
          summary: expect.stringContaining("Runtime audit log is not writable"),
        }),
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("checks configured session socket directory writability", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-socket-"));
    const socketPath = join(workspaceRoot, "sockets/session.sock");

    try {
      const result = await runRuntimeDoctor({
        config: TEST_CONFIG,
        workspaceRoot,
        socketPath,
        credentialStore: new MemoryCredentialStore("unavailable"),
      });

      expect(result.checks).toContainEqual({
        id: "session-socket",
        status: "ok",
        summary: `Session socket directory is writable for ${socketPath}.`,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("reports socket paths blocked by non-socket files", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-socket-bad-"));
    const socketPath = join(workspaceRoot, "session.sock");
    await writeFile(socketPath, "not a socket", "utf8");

    try {
      const result = await runRuntimeDoctor({
        config: TEST_CONFIG,
        workspaceRoot,
        socketPath,
        credentialStore: new MemoryCredentialStore("unavailable"),
      });

      expect(result.checks).toContainEqual({
        id: "session-socket",
        status: "error",
        summary: `Socket path is blocked by a non-socket file at ${socketPath}.`,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("warns when a session socket path is already in use", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-socket-live-"));
    const socketPath = join(workspaceRoot, "session.sock");
    const server = createSlopServer({ id: "doctor-socket-test", name: "Doctor Socket Test" });
    const listener = listenUnix(server, socketPath, { register: false });

    try {
      const result = await runRuntimeDoctor({
        config: TEST_CONFIG,
        workspaceRoot,
        socketPath,
        credentialStore: new MemoryCredentialStore("unavailable"),
      });

      expect(result.checks).toContainEqual({
        id: "session-socket",
        status: "warning",
        summary: `Socket path already exists at ${socketPath}.`,
        detail:
          "If this is a live session, choose another path. If it is stale, stop/start cleanup can remove it.",
      });
    } finally {
      listener.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("reports missing filesystem roots before startup", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-root-missing-"));
    const missingRoot = join(workspaceRoot, "missing-root");

    try {
      const result = await runRuntimeDoctor({
        config: {
          ...TEST_CONFIG,
          providers: {
            ...TEST_CONFIG.providers,
            builtin: {
              ...TEST_CONFIG.providers.builtin,
              terminal: true,
            },
            filesystem: {
              ...TEST_CONFIG.providers.filesystem,
              root: missingRoot,
            },
            terminal: {
              ...TEST_CONFIG.providers.terminal,
              cwd: missingRoot,
            },
          },
        },
        workspaceRoot,
        credentialStore: new MemoryCredentialStore("unavailable"),
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({
          id: "workspace-paths",
          status: "error",
          summary: "2 workspace path check(s) failed.",
          detail: expect.stringContaining("Filesystem root is not readable as a directory"),
        }),
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("reports terminal cwd outside the filesystem root", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-root-contain-"));
    const filesystemRoot = join(workspaceRoot, "workspace");
    const outsideRoot = join(workspaceRoot, "outside");
    await mkdir(filesystemRoot);
    await mkdir(outsideRoot);

    try {
      const result = await runRuntimeDoctor({
        config: {
          ...TEST_CONFIG,
          providers: {
            ...TEST_CONFIG.providers,
            builtin: {
              ...TEST_CONFIG.providers.builtin,
              terminal: true,
            },
            filesystem: {
              ...TEST_CONFIG.providers.filesystem,
              root: filesystemRoot,
            },
            terminal: {
              ...TEST_CONFIG.providers.terminal,
              cwd: outsideRoot,
            },
          },
        },
        workspaceRoot,
        credentialStore: new MemoryCredentialStore("unavailable"),
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({
          id: "workspace-paths",
          status: "error",
          summary: "1 workspace path check(s) failed.",
          detail: expect.stringContaining("Terminal cwd must stay inside the filesystem root."),
        }),
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("checks the selected ACP adapter startup command", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-acp-command-"));

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
                  local: {
                    command: [process.execPath, "-e", "process.stdin.resume()"],
                  },
                },
              },
            },
          },
        },
        workspaceRoot,
        acpAdapterId: "local",
        timeoutMs: 100,
        credentialStore: new MemoryCredentialStore("unavailable"),
      });

      expect(result.checks).toContainEqual({
        id: "subprocess-commands",
        status: "ok",
        summary: "1 startup subprocess command(s) are executable.",
        detail: `acp:local -> ${process.execPath}`,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("reports missing selected ACP adapter startup commands before spawn", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "sloppy-runtime-doctor-acp-command-missing-"),
    );
    const missingCommand = join(workspaceRoot, "missing-acp");

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
                  missing: {
                    command: [missingCommand],
                  },
                },
              },
            },
          },
        },
        workspaceRoot,
        acpAdapterId: "missing",
        timeoutMs: 100,
        credentialStore: new MemoryCredentialStore("unavailable"),
      });

      expect(result.checks).toContainEqual({
        id: "subprocess-commands",
        status: "error",
        summary: "1 startup subprocess command(s) are missing or not executable.",
        detail: `acp:missing: command '${missingCommand}' is not executable from cwd ${workspaceRoot}.`,
      });
      expect(result.checks).toContainEqual({
        id: "acp",
        status: "error",
        summary: "ACP adapter 'missing' command is not executable.",
        detail: `command='${missingCommand}' cwd=${workspaceRoot}`,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("checks required MCP stdio startup commands", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-mcp-command-"));

    try {
      const result = await runRuntimeDoctor({
        config: {
          ...TEST_CONFIG,
          providers: {
            ...TEST_CONFIG.providers,
            builtin: {
              ...TEST_CONFIG.providers.builtin,
              mcp: true,
            },
            mcp: {
              connectOnStart: true,
              servers: {
                local: {
                  transport: "stdio",
                  command: [process.execPath, "--version"],
                },
              },
            },
          },
        },
        workspaceRoot,
        credentialStore: new MemoryCredentialStore("unavailable"),
      });

      expect(result.checks).toContainEqual({
        id: "subprocess-commands",
        status: "ok",
        summary: "1 startup subprocess command(s) are executable.",
        detail: `mcp:local -> ${process.execPath}`,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("does not require on-demand MCP stdio commands", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-mcp-on-demand-"));

    try {
      const result = await runRuntimeDoctor({
        config: {
          ...TEST_CONFIG,
          providers: {
            ...TEST_CONFIG.providers,
            builtin: {
              ...TEST_CONFIG.providers.builtin,
              mcp: true,
            },
            mcp: {
              connectOnStart: false,
              servers: {
                later: {
                  transport: "stdio",
                  command: [join(workspaceRoot, "missing-on-demand-mcp")],
                },
              },
            },
          },
        },
        workspaceRoot,
        credentialStore: new MemoryCredentialStore("unavailable"),
      });

      expect(result.checks).toContainEqual({
        id: "subprocess-commands",
        status: "skipped",
        summary: "No startup subprocess commands are configured.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("reports missing MCP stdio startup commands before startup", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-mcp-missing-"));
    const missingCommand = join(workspaceRoot, "missing-mcp-server");

    try {
      const result = await runRuntimeDoctor({
        config: {
          ...TEST_CONFIG,
          providers: {
            ...TEST_CONFIG.providers,
            builtin: {
              ...TEST_CONFIG.providers.builtin,
              mcp: true,
            },
            mcp: {
              connectOnStart: true,
              servers: {
                missing: {
                  transport: "stdio",
                  command: [missingCommand],
                },
              },
            },
          },
        },
        workspaceRoot,
        credentialStore: new MemoryCredentialStore("unavailable"),
      });

      expect(result.checks).toContainEqual({
        id: "subprocess-commands",
        status: "error",
        summary: "1 startup subprocess command(s) are missing or not executable.",
        detail: `mcp:missing: command '${missingCommand}' is not executable from cwd ${workspaceRoot}.`,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("reports active LLM profile readiness from secure credentials", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-llm-ready-"));
    delete process.env.OPENAI_API_KEY;

    try {
      const result = await runRuntimeDoctor({
        config: {
          ...TEST_CONFIG,
          llm: {
            ...TEST_CONFIG.llm,
            defaultProfileId: "managed-openai",
            profiles: [
              {
                id: "managed-openai",
                label: "Managed OpenAI",
                provider: "openai",
                model: "gpt-5.4",
                apiKeyEnv: "OPENAI_API_KEY",
              },
            ],
          },
        },
        workspaceRoot,
        credentialStore: new MemoryCredentialStore(
          "available",
          new Map([["managed-openai", "sk-test"]]),
        ),
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({
          id: "llm-profile",
          status: "ok",
          summary: "Active LLM profile 'managed-openai' is ready using stored credentials.",
        }),
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("warns when the active LLM profile relies on process environment credentials", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-llm-env-"));
    process.env.OPENAI_API_KEY = "sk-env-test";

    try {
      const result = await runRuntimeDoctor({
        config: TEST_CONFIG,
        workspaceRoot,
        credentialStore: new MemoryCredentialStore("unavailable"),
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({
          id: "llm-profile",
          status: "warning",
          summary: expect.stringContaining("process environment credentials"),
        }),
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("errors when no LLM profile is ready", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-llm-missing-"));
    delete process.env.OPENAI_API_KEY;

    try {
      const result = await runRuntimeDoctor({
        config: TEST_CONFIG,
        workspaceRoot,
        credentialStore: new MemoryCredentialStore("unavailable"),
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({
          id: "llm-profile",
          status: "error",
          summary: expect.stringContaining("No ready LLM profile is available."),
        }),
      );
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

  test("uses the requested workspace as the config normalization root", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-workspace-"));
    await mkdir(join(workspaceRoot, ".sloppy"), { recursive: true });
    await mkdir(join(workspaceRoot, "project"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".sloppy/config.yaml"),
      ["llm:", "  provider: anthropic", "providers:", "  filesystem:", "    root: project"].join(
        "\n",
      ),
      "utf8",
    );

    try {
      const result = await runRuntimeDoctor({ workspaceRoot });
      expect(result.checks).toContainEqual({
        id: "session-persistence",
        status: "ok",
        summary: `No session snapshots found at ${join(
          workspaceRoot,
          "project/.sloppy/sessions",
        )}; the directory will be created on first write.`,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("validates persisted session and meta-runtime state envelopes", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-persistence-"));
    const sessionDir = join(workspaceRoot, ".sloppy/sessions");
    const metaRoot = join(workspaceRoot, ".sloppy/meta-runtime");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(metaRoot, { recursive: true });
    await writeFile(
      join(sessionDir, "default.json"),
      `${JSON.stringify(
        {
          kind: "sloppy.session.snapshot",
          schema_version: 1,
          saved_at: "2026-01-01T00:00:00.000Z",
          snapshot: {
            session: {},
            llm: {},
            turn: {},
            transcript: [],
            activity: [],
            approvals: [],
            tasks: [],
            apps: [],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(metaRoot, "state.json"),
      `${JSON.stringify(
        {
          kind: "sloppy.meta-runtime.state",
          schema_version: 1,
          saved_at: "2026-01-01T00:00:00.000Z",
          state: {},
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    try {
      const result = await runRuntimeDoctor({
        config: {
          ...TEST_CONFIG,
          session: { persistSnapshots: true, persistenceDir: ".sloppy/sessions" },
          providers: {
            ...TEST_CONFIG.providers,
            builtin: {
              ...TEST_CONFIG.providers.builtin,
              metaRuntime: true,
            },
            filesystem: {
              ...TEST_CONFIG.providers.filesystem,
              root: workspaceRoot,
            },
            metaRuntime: {
              ...TEST_CONFIG.providers.metaRuntime,
              globalRoot: join(workspaceRoot, ".sloppy/global-meta-runtime"),
              workspaceRoot: metaRoot,
            },
          },
        },
        workspaceRoot,
      });

      expect(result.checks).toContainEqual({
        id: "session-persistence",
        status: "ok",
        summary: "1 persisted session snapshot file(s) use the current schema envelope.",
      });
      expect(result.checks).toContainEqual({
        id: "meta-runtime-persistence",
        status: "ok",
        summary: "1 persisted meta-runtime state file(s) use the current schema envelope.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("migrates legacy persisted state envelopes with backups", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-migrate-"));
    const sessionDir = join(workspaceRoot, ".sloppy/sessions");
    const metaRoot = join(workspaceRoot, ".sloppy/meta-runtime");
    const sessionPath = join(sessionDir, "default.json");
    const metaPath = join(metaRoot, "state.json");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(metaRoot, { recursive: true });
    const now = "2026-01-01T00:00:00.000Z";
    await writeFile(
      sessionPath,
      `${JSON.stringify(
        {
          session: {
            sessionId: "legacy",
            status: "active",
            modelProvider: "openai",
            model: "gpt-5.4",
            startedAt: now,
            updatedAt: now,
            lastActivityAt: now,
            clientCount: 0,
            connectedClients: [],
          },
          llm: {
            status: "needs_credentials",
            message: "Add an API key to start the agent.",
            activeProfileId: "default",
            selectedProvider: "openai",
            selectedModel: "gpt-5.4",
            secureStoreKind: "none",
            secureStoreStatus: "unsupported",
            profiles: [],
          },
          turn: {
            turnId: null,
            state: "idle",
            phase: "none",
            iteration: 0,
            startedAt: null,
            updatedAt: now,
            message: "Idle",
          },
          goal: null,
          queue: [],
          transcript: [],
          activity: [],
          approvals: [],
          tasks: [],
          apps: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(metaPath, `${JSON.stringify({ profiles: [] }, null, 2)}\n`, "utf8");

    try {
      const result = await runRuntimeDoctor({
        config: {
          ...TEST_CONFIG,
          session: { persistSnapshots: true, persistenceDir: ".sloppy/sessions" },
          providers: {
            ...TEST_CONFIG.providers,
            builtin: {
              ...TEST_CONFIG.providers.builtin,
              metaRuntime: true,
            },
            metaRuntime: {
              ...TEST_CONFIG.providers.metaRuntime,
              globalRoot: join(workspaceRoot, ".sloppy/global-meta-runtime"),
              workspaceRoot: metaRoot,
            },
          },
        },
        workspaceRoot,
        migratePersistence: true,
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({
          id: "session-persistence",
          status: "ok",
          summary:
            "1 legacy session snapshot file(s) were migrated to the current schema envelope.",
          detail: expect.stringContaining("backup="),
        }),
      );
      expect(result.checks).toContainEqual(
        expect.objectContaining({
          id: "meta-runtime-persistence",
          status: "ok",
          summary:
            "1 legacy meta-runtime state file(s) were migrated to the current schema envelope.",
          detail: expect.stringContaining("backup="),
        }),
      );

      const migratedSession = JSON.parse(await readFile(sessionPath, "utf8")) as {
        kind?: string;
        snapshot?: unknown;
      };
      expect(migratedSession.kind).toBe("sloppy.session.snapshot");
      expect(migratedSession.snapshot).toEqual(
        expect.objectContaining({
          transcript: [],
          activity: [],
          approvals: [],
          tasks: [],
          apps: [],
        }),
      );
      const migratedMeta = JSON.parse(await readFile(metaPath, "utf8")) as {
        kind?: string;
        state?: unknown;
      };
      expect(migratedMeta.kind).toBe("sloppy.meta-runtime.state");
      expect(migratedMeta.state).toEqual({ profiles: [] });
      expect((await readdir(sessionDir)).filter((entry) => entry.endsWith(".bak"))).toHaveLength(1);
      expect((await readdir(metaRoot)).filter((entry) => entry.endsWith(".bak"))).toHaveLength(1);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("reports unsupported persisted state schemas before runtime startup", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "sloppy-runtime-doctor-bad-persist-"));
    const sessionDir = join(workspaceRoot, ".sloppy/sessions");
    const metaRoot = join(workspaceRoot, ".sloppy/meta-runtime");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(metaRoot, { recursive: true });
    await writeFile(
      join(sessionDir, "default.json"),
      JSON.stringify({ kind: "sloppy.session.snapshot", schema_version: 999, snapshot: {} }),
      "utf8",
    );
    await writeFile(
      join(metaRoot, "state.json"),
      JSON.stringify({ kind: "sloppy.meta-runtime.state", schema_version: 999, state: {} }),
      "utf8",
    );

    try {
      const result = await runRuntimeDoctor({
        config: {
          ...TEST_CONFIG,
          session: { persistSnapshots: true, persistenceDir: ".sloppy/sessions" },
          providers: {
            ...TEST_CONFIG.providers,
            filesystem: {
              ...TEST_CONFIG.providers.filesystem,
              root: workspaceRoot,
            },
            metaRuntime: {
              ...TEST_CONFIG.providers.metaRuntime,
              globalRoot: join(workspaceRoot, ".sloppy/global-meta-runtime"),
              workspaceRoot: metaRoot,
            },
          },
        },
        workspaceRoot,
      });

      expect(result.checks).toContainEqual(
        expect.objectContaining({
          id: "session-persistence",
          status: "error",
          summary: "1 persisted session snapshot file(s) could not be loaded.",
        }),
      );
      expect(result.checks).toContainEqual(
        expect.objectContaining({
          id: "meta-runtime-persistence",
          status: "error",
          summary: "1 persisted meta-runtime state file(s) could not be loaded.",
        }),
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
