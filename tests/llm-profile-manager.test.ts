import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CredentialStore, CredentialStoreStatus } from "../src/llm/credential-store";
import { LlmProfileManager } from "../src/llm/profile-manager";
import { createRuntimeLlmProfileManager } from "../src/llm/runtime-config";
import { createTestConfig } from "./helpers/config";

const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalOpenAIKey = process.env.OPENAI_API_KEY;
const originalGeminiKey = process.env.GEMINI_API_KEY;
const originalEndpoint = process.env.SLOPPY_LLM_ENDPOINT;
const originalProfile = process.env.SLOPPY_LLM_PROFILE;
const originalModel = process.env.SLOPPY_MODEL;
const originalReasoningEffort = process.env.SLOPPY_LLM_REASONING_EFFORT;
const originalCodexAuthPath = process.env.SLOPPY_CODEX_AUTH_PATH;

const TEST_CONFIG = createTestConfig({
  llm: {
    defaultProfileId: "openai-main",
    profiles: [
      {
        kind: "native",
        id: "openai-main",
        label: "OpenAI Main",
        endpointId: "openai",
        model: "gpt-5.4",
      },
    ],
  },
});

class MemoryCredentialStore implements CredentialStore {
  readonly kind = "keychain" as const;

  constructor(
    private status: CredentialStoreStatus = "available",
    readonly secrets = new Map<string, string>(),
  ) {}

  async getStatus(): Promise<CredentialStoreStatus> {
    return this.status;
  }

  async get(endpointId: string): Promise<string | null> {
    return this.secrets.get(endpointId) ?? null;
  }

  async set(endpointId: string, secret: string): Promise<void> {
    this.secrets.set(endpointId, secret);
  }

  async delete(endpointId: string): Promise<void> {
    this.secrets.delete(endpointId);
  }
}

afterEach(() => {
  const restore = (name: string, value: string | undefined) => {
    if (value == null) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  };

  restore("ANTHROPIC_API_KEY", originalAnthropicKey);
  restore("OPENAI_API_KEY", originalOpenAIKey);
  restore("GEMINI_API_KEY", originalGeminiKey);
  restore("SLOPPY_LLM_ENDPOINT", originalEndpoint);
  restore("SLOPPY_LLM_PROFILE", originalProfile);
  restore("SLOPPY_MODEL", originalModel);
  restore("SLOPPY_LLM_REASONING_EFFORT", originalReasoningEffort);
  restore("SLOPPY_CODEX_AUTH_PATH", originalCodexAuthPath);
});

describe("LlmProfileManager", () => {
  test("reports onboarding state when no credentials are available", async () => {
    delete process.env.OPENAI_API_KEY;

    const manager = new LlmProfileManager({
      config: TEST_CONFIG,
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
    });

    const state = await manager.getState();

    expect(state.status).toBe("needs_credentials");
    expect(state.activeProfileId).toBe("openai-main");
    expect(state.selectedEndpointId).toBe("openai");
    expect(state.profiles[0]?.ready).toBe(false);
    expect(state.message).toContain("OPENAI_API_KEY");
  });

  test("exposes context window metadata from endpoint models", async () => {
    const manager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          endpoints: {
            openai: {
              protocol: "openai-chat",
              auth: { type: "env", env: "OPENAI_API_KEY" },
              models: {
                "gpt-5.4": {
                  contextWindowTokens: 123_456,
                },
              },
            },
          },
          defaultProfileId: "openai-main",
          profiles: [
            {
              kind: "native",
              id: "openai-main",
              endpointId: "openai",
              model: "gpt-5.4",
            },
          ],
        },
      }),
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
    });

    const state = await manager.getState();

    expect(state.selectedContextWindowTokens).toBe(123_456);
    expect(state.profiles[0]?.contextWindowTokens).toBe(123_456);
  });

  test("uses a provider-agnostic onboarding message before any managed profile exists", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const manager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          defaultProfileId: undefined,
          profiles: [],
        },
      }),
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
    });

    const state = await manager.getState();

    expect(state.status).toBe("needs_credentials");
    expect(state.message).toContain("No ready LLM profile is configured yet");
    expect(state.message).toContain("ANTHROPIC_API_KEY");
  });

  test("lists environment credentials separately and does not override the managed default", async () => {
    process.env.OPENAI_API_KEY = "env-key";

    const manager = new LlmProfileManager({
      config: TEST_CONFIG,
      credentialStore: new MemoryCredentialStore("available", new Map([["openai", "stored-key"]])),
      writeConfig: async () => undefined,
    });

    const state = await manager.getState();

    expect(state.status).toBe("ready");
    expect(state.activeProfileId).toBe("openai-main");
    expect(state.profiles.find((profile) => profile.id === "openai-main")?.keySource).toBe(
      "secure_store",
    );

    const envProfile = state.profiles.find((profile) => profile.origin === "environment");
    expect(envProfile?.endpointId).toBe("openai");
    expect(envProfile?.keySource).toBe("env");
    expect(envProfile?.isDefault).toBe(false);
  });

  test("falls back to legacy profile-scoped stored API keys", async () => {
    delete process.env.OPENAI_API_KEY;

    const manager = new LlmProfileManager({
      config: TEST_CONFIG,
      credentialStore: new MemoryCredentialStore(
        "available",
        new Map([["openai-main", "stored-key"]]),
      ),
      writeConfig: async () => undefined,
    });

    const state = await manager.getState();

    expect(state.status).toBe("ready");
    expect(state.activeProfileId).toBe("openai-main");
    expect(state.profiles.find((profile) => profile.id === "openai-main")?.keySource).toBe(
      "secure_store",
    );
  });

  test("runtime profile manager honors explicit endpoint routing", async () => {
    process.env.OPENAI_API_KEY = "router-key";
    process.env.SLOPPY_LLM_ENDPOINT = "openai";
    process.env.SLOPPY_MODEL = "local/test-model";
    process.env.SLOPPY_LLM_REASONING_EFFORT = "low";

    const manager = createRuntimeLlmProfileManager({
      config: TEST_CONFIG,
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
      env: process.env,
    });

    const state = await manager.getState();
    const activeProfile = state.profiles.find((profile) => profile.id === state.activeProfileId);

    expect(state.activeProfileId).toBe("runtime");
    expect(state.selectedEndpointId).toBe("openai");
    expect(state.selectedModel).toBe("local/test-model");
    expect(activeProfile?.reasoningEffort).toBe("low");
    expect(activeProfile?.keySource).toBe("env");
  });

  test("allows selecting an environment-backed profile as the active default", async () => {
    process.env.GEMINI_API_KEY = "gemini-env-key";

    let persistedDefaultProfileId: string | undefined;
    const manager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          defaultProfileId: undefined,
          profiles: [],
        },
      }),
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async (config) => {
        persistedDefaultProfileId = config.defaultProfileId;
      },
    });

    const initialState = await manager.getState();
    const envProfile = initialState.profiles.find(
      (profile) => profile.origin === "environment" && profile.endpointId === "gemini",
    );

    expect(envProfile).toBeTruthy();
    const envProfileId = envProfile?.id;
    expect(envProfileId).toBeTruthy();
    if (!envProfileId) {
      throw new Error("Expected an environment-backed Gemini profile.");
    }

    const nextState = await manager.setDefaultProfile(envProfileId);

    expect(nextState.activeProfileId).toBe(envProfileId);
    expect(nextState.selectedEndpointId).toBe("gemini");
    expect(nextState.profiles.find((profile) => profile.id === envProfileId)?.isDefault).toBe(true);
    expect(persistedDefaultProfileId).toBe(envProfileId);
  });

  test("saving from an environment profile creates a managed profile instead of mutating the env entry", async () => {
    process.env.OPENAI_API_KEY = "env-key";

    const manager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          defaultProfileId: undefined,
          profiles: [],
        },
      }),
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
    });

    const initialState = await manager.getState();
    const envProfile = initialState.profiles.find((profile) => profile.origin === "environment");

    const nextState = await manager.saveProfile({
      profileId: envProfile?.id,
      label: "Managed OpenAI",
      endpointId: "openai",
      model: "gpt-5.4",
      apiKey: "stored-key",
      makeDefault: true,
    });

    expect(
      nextState.profiles.some((profile) => profile.id === envProfile?.id && profile.managed),
    ).toBe(false);
    expect(
      nextState.profiles.some((profile) => profile.managed && profile.label === "Managed OpenAI"),
    ).toBe(true);
  });

  test("saves profile metadata and stores API keys securely by endpoint", async () => {
    const store = new MemoryCredentialStore("available");
    let persistedProfileId: string | undefined;

    const manager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          defaultProfileId: undefined,
          profiles: [],
        },
      }),
      credentialStore: store,
      writeConfig: async (config) => {
        persistedProfileId = config.defaultProfileId;
      },
    });

    const state = await manager.saveProfile({
      label: "Primary Gemini",
      endpointId: "gemini",
      model: "gemini-2.5-pro",
      apiKey: "secret-key",
      makeDefault: true,
    });

    expect(state.status).toBe("ready");
    const managedProfile = state.profiles.find((profile) => profile.origin === "managed");
    expect(managedProfile?.endpointId).toBe("gemini");
    expect(managedProfile?.keySource).toBe("secure_store");
    expect(persistedProfileId).toBe(managedProfile?.id);
    expect(store.secrets.get("gemini")).toBe("secret-key");
  });

  test("rejects stored key deletion through environment-backed profiles", async () => {
    process.env.OPENAI_API_KEY = "env-key";
    const store = new MemoryCredentialStore("available", new Map([["openai", "stored-key"]]));
    const manager = new LlmProfileManager({
      config: TEST_CONFIG,
      credentialStore: store,
      writeConfig: async () => undefined,
    });

    const state = await manager.getState();
    const envProfile = state.profiles.find(
      (profile) => profile.origin === "environment" && profile.endpointId === "openai",
    );

    expect(envProfile?.canDeleteApiKey).toBe(false);
    expect(envProfile?.id).toBeTruthy();
    if (!envProfile) {
      throw new Error("Expected an environment-backed OpenAI profile.");
    }

    await expect(manager.deleteApiKey(envProfile.id)).rejects.toThrow(
      "Cannot delete stored endpoint credentials for profile",
    );
    expect(store.secrets.get("openai")).toBe("stored-key");
  });

  test("deletes endpoint credentials only after the last managed endpoint profile is deleted", async () => {
    delete process.env.OPENAI_API_KEY;
    const store = new MemoryCredentialStore(
      "available",
      new Map([
        ["openai", "stored-key"],
        ["openai-alt", "legacy-profile-key"],
      ]),
    );
    const manager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          defaultProfileId: "openai-main",
          profiles: [
            {
              kind: "native",
              id: "openai-main",
              endpointId: "openai",
              model: "gpt-5.4",
            },
            {
              kind: "native",
              id: "openai-alt",
              endpointId: "openai",
              model: "gpt-5.4-mini",
            },
          ],
        },
      }),
      credentialStore: store,
      writeConfig: async () => undefined,
    });

    await manager.deleteProfile("openai-alt");

    expect(store.secrets.get("openai")).toBe("stored-key");
    expect(store.secrets.has("openai-alt")).toBe(false);

    await manager.deleteProfile("openai-main");

    expect(store.secrets.has("openai")).toBe(false);
  });

  test("treats session-agent profiles as ready model profiles without API keys", async () => {
    const manager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          defaultProfileId: "claude-sonnet",
          profiles: [
            {
              kind: "session-agent",
              id: "claude-sonnet",
              label: "Claude Sonnet",
              model: "sonnet",
              adapterId: "claude",
            },
          ],
        },
      }),
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
    });

    const state = await manager.getState();

    expect(state.status).toBe("ready");
    expect(state.selectedProtocol).toBe("session-agent");
    expect(state.selectedModel).toBe("sonnet");
    expect(state.profiles[0]?.adapterId).toBe("claude");
    expect(state.profiles[0]?.keySource).toBe("not_required");
    expect(state.profiles[0]?.canDeleteApiKey).toBe(false);
  });

  test("treats OpenAI Codex profiles as ready when Codex auth is available", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-codex-auth-"));
    try {
      const authPath = join(root, "auth.json");
      await writeFile(
        authPath,
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            access_token: "codex-access-token",
            refresh_token: "codex-refresh-token",
            account_id: "codex-account",
          },
        }),
      );
      process.env.SLOPPY_CODEX_AUTH_PATH = authPath;

      const manager = new LlmProfileManager({
        config: createTestConfig({
          llm: {
            defaultProfileId: "codex-native",
            profiles: [
              {
                kind: "native",
                id: "codex-native",
                label: "Codex GPT-5.5",
                endpointId: "openai-codex",
                model: "gpt-5.5",
                reasoningEffort: "low",
              },
            ],
          },
        }),
        credentialStore: new MemoryCredentialStore("available"),
        writeConfig: async () => undefined,
      });

      const state = await manager.getState();

      expect(state.status).toBe("ready");
      expect(state.selectedEndpointId).toBe("openai-codex");
      expect(state.selectedModel).toBe("gpt-5.5");
      expect(state.profiles[0]?.reasoningEffort).toBe("low");
      expect(state.profiles[0]?.keySource).toBe("external_auth");
      expect(state.profiles[0]?.canDeleteApiKey).toBe(false);
      expect(state.message).toContain("external auth");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("persists adapter ids when saving session-agent profiles", async () => {
    let persistedAdapterId: string | undefined;
    const manager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          defaultProfileId: undefined,
          profiles: [],
        },
      }),
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async (config) => {
        const profile = config.profiles[0];
        persistedAdapterId = profile?.kind === "session-agent" ? profile.adapterId : undefined;
      },
    });

    const state = await manager.saveProfile({
      kind: "session-agent",
      label: "Claude Sonnet",
      model: "sonnet",
      adapterId: "claude",
      makeDefault: true,
    });

    expect(state.status).toBe("ready");
    expect(state.profiles[0]?.kind).toBe("session-agent");
    expect(state.profiles[0]?.adapterId).toBe("claude");
    expect(persistedAdapterId).toBe("claude");
  });

  test("marks invalid OpenRouter keys as not ready before a model turn starts", async () => {
    const manager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          defaultProfileId: "openrouter-main",
          profiles: [
            {
              kind: "native",
              id: "openrouter-main",
              label: "OpenRouter Main",
              endpointId: "openrouter",
              model: "claude-opus-4-6",
            },
          ],
        },
      }),
      credentialStore: new MemoryCredentialStore(
        "available",
        new Map([["openrouter", "sk-this-is-an-openai-key"]]),
      ),
      writeConfig: async () => undefined,
    });

    const state = await manager.getState();

    expect(state.status).toBe("needs_credentials");
    expect(state.profiles[0]?.keySource).toBe("secure_store");
    expect(state.profiles[0]?.ready).toBe(false);
    expect(state.message).toContain("OpenRouter API key does not look valid");
  });
});
