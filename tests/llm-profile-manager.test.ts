import { afterEach, describe, expect, test } from "bun:test";

import type { SloppyConfig } from "../src/config/schema";
import type { CredentialStore, CredentialStoreStatus } from "../src/llm/credential-store";
import { LlmProfileManager } from "../src/llm/profile-manager";
import { buildRuntimeLlmConfig, createRuntimeLlmProfileManager } from "../src/llm/runtime-config";

const originalOpenAIKey = process.env.OPENAI_API_KEY;
const originalGeminiKey = process.env.GEMINI_API_KEY;
const originalLiteLlmKey = process.env.LITELLM_API_KEY;
const originalProvider = process.env.SLOPPY_LLM_PROVIDER;
const originalModel = process.env.SLOPPY_MODEL;
const originalAdapterId = process.env.SLOPPY_LLM_ADAPTER_ID;
const originalBaseUrl = process.env.SLOPPY_LLM_BASE_URL;
const originalApiKeyEnv = process.env.SLOPPY_LLM_API_KEY_ENV;

const TEST_CONFIG: SloppyConfig = {
  llm: {
    provider: "openai",
    model: "gpt-5.4",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultProfileId: "openai-main",
    profiles: [
      {
        id: "openai-main",
        label: "OpenAI Main",
        provider: "openai",
        model: "gpt-5.4",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    ],
    maxTokens: 4096,
  },
  agent: {
    maxIterations: 12,
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
      web: false,
      browser: false,
      cron: false,
      messaging: false,
      delegation: false,
      metaRuntime: false,
      spec: false,
      vision: false,
    },
    discovery: {
      enabled: false,
      paths: [],
    },
    terminal: {
      cwd: ".",
      historyLimit: 10,
      syncTimeoutMs: 30000,
    },
    filesystem: {
      root: ".",
      focus: ".",
      recentLimit: 10,
      searchLimit: 20,
      readMaxBytes: 65536,
      contentRefThresholdBytes: 8192,
      previewBytes: 2048,
    },
    memory: {
      maxMemories: 500,
      defaultWeight: 0.5,
      compactThreshold: 0.2,
    },
    skills: {
      skillsDir: "~/.sloppy/skills",
    },
    web: {
      historyLimit: 20,
    },
    browser: {
      viewportWidth: 1280,
      viewportHeight: 720,
    },
    cron: {
      maxJobs: 50,
    },
    messaging: {
      maxMessages: 500,
    },
    delegation: {
      maxAgents: 10,
    },
    metaRuntime: { globalRoot: "~/.sloppy/meta-runtime", workspaceRoot: ".sloppy/meta-runtime" },
    vision: {
      maxImages: 50,
      defaultWidth: 512,
      defaultHeight: 512,
    },
  },
};

class MemoryCredentialStore implements CredentialStore {
  readonly kind = "keychain" as const;

  constructor(
    private status: CredentialStoreStatus = "available",
    readonly secrets = new Map<string, string>(),
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

afterEach(() => {
  if (originalOpenAIKey == null) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIKey;
  }

  if (originalGeminiKey == null) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = originalGeminiKey;
  }

  if (originalLiteLlmKey == null) {
    delete process.env.LITELLM_API_KEY;
  } else {
    process.env.LITELLM_API_KEY = originalLiteLlmKey;
  }

  if (originalProvider == null) {
    delete process.env.SLOPPY_LLM_PROVIDER;
  } else {
    process.env.SLOPPY_LLM_PROVIDER = originalProvider;
  }

  if (originalModel == null) {
    delete process.env.SLOPPY_MODEL;
  } else {
    process.env.SLOPPY_MODEL = originalModel;
  }

  if (originalBaseUrl == null) {
    delete process.env.SLOPPY_LLM_BASE_URL;
  } else {
    process.env.SLOPPY_LLM_BASE_URL = originalBaseUrl;
  }

  if (originalAdapterId == null) {
    delete process.env.SLOPPY_LLM_ADAPTER_ID;
  } else {
    process.env.SLOPPY_LLM_ADAPTER_ID = originalAdapterId;
  }

  if (originalApiKeyEnv == null) {
    delete process.env.SLOPPY_LLM_API_KEY_ENV;
  } else {
    process.env.SLOPPY_LLM_API_KEY_ENV = originalApiKeyEnv;
  }
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
    expect(state.profiles[0]?.ready).toBe(false);
    expect(state.message).toContain("OPENAI_API_KEY");
  });

  test("uses a provider-agnostic onboarding message before any managed profile exists", async () => {
    delete process.env.OPENAI_API_KEY;

    const manager = new LlmProfileManager({
      config: {
        ...TEST_CONFIG,
        llm: {
          ...TEST_CONFIG.llm,
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          defaultProfileId: undefined,
          profiles: [],
        },
      },
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

    const envProfile = state.profiles.find((profile) => profile.origin === "environment");
    expect(envProfile?.provider).toBe("openai");
    expect(envProfile?.keySource).toBe("env");
    expect(envProfile?.isDefault).toBe(false);
  });

  test("can pin a one-shot run to env routing without exposing managed profiles", async () => {
    process.env.OPENAI_API_KEY = "stub-key";
    process.env.SLOPPY_LLM_PROVIDER = "openai";
    process.env.SLOPPY_MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";
    process.env.SLOPPY_LLM_BASE_URL = "http://192.168.1.96:8001/v1";

    const manager = new LlmProfileManager({
      config: {
        ...TEST_CONFIG,
        llm: buildRuntimeLlmConfig(
          {
            ...TEST_CONFIG.llm,
            provider: "openai",
            model: "Qwen/Qwen3.6-35B-A3B-FP8",
            baseUrl: "http://192.168.1.96:8001/v1",
          },
          process.env,
        ),
      },
      credentialStore: new MemoryCredentialStore(
        "available",
        new Map([["openai-main", "sk-stored-cloud-key"]]),
      ),
      writeConfig: async () => undefined,
    });

    const state = await manager.getState();
    const activeProfile = state.profiles.find((profile) => profile.id === state.activeProfileId);

    expect(state.activeProfileId).toStartWith("env-openai-openai-api-key-");
    expect(state.selectedModel).toBe("Qwen/Qwen3.6-35B-A3B-FP8");
    expect(activeProfile?.baseUrl).toBe("http://192.168.1.96:8001/v1");
    expect(activeProfile?.keySource).toBe("env");
    expect(activeProfile?.origin).toBe("environment");
    expect(state.profiles.every((profile) => profile.origin !== "managed")).toBe(true);
  });

  test("runtime profile manager honors explicit env routing by default", async () => {
    process.env.LITELLM_API_KEY = "router-key";
    process.env.SLOPPY_LLM_PROVIDER = "openai";
    process.env.SLOPPY_MODEL = "local/test-model";
    process.env.SLOPPY_LLM_BASE_URL = "http://sloppy-mba.local:8001/v1";
    process.env.SLOPPY_LLM_API_KEY_ENV = "LITELLM_API_KEY";

    const manager = createRuntimeLlmProfileManager({
      config: TEST_CONFIG,
      credentialStore: new MemoryCredentialStore(
        "available",
        new Map([["openai-main", "sk-stored-cloud-key"]]),
      ),
      writeConfig: async () => undefined,
      env: process.env,
    });

    const state = await manager.getState();
    const activeProfile = state.profiles.find((profile) => profile.id === state.activeProfileId);

    expect(state.activeProfileId).toStartWith("env-openai-litellm-api-key-");
    expect(state.selectedModel).toBe("local/test-model");
    expect(activeProfile?.baseUrl).toBe("http://sloppy-mba.local:8001/v1");
    expect(activeProfile?.keySource).toBe("env");
    expect(state.profiles.every((profile) => profile.origin !== "managed")).toBe(true);
  });

  test("allows selecting an environment-backed profile as the active default", async () => {
    process.env.GEMINI_API_KEY = "gemini-env-key";

    let persistedDefaultProfileId: string | undefined;
    const manager = new LlmProfileManager({
      config: {
        ...TEST_CONFIG,
        llm: {
          ...TEST_CONFIG.llm,
          defaultProfileId: undefined,
          profiles: [],
        },
      },
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async (config) => {
        persistedDefaultProfileId = config.defaultProfileId;
      },
    });

    const initialState = await manager.getState();
    const envProfile = initialState.profiles.find(
      (profile) => profile.origin === "environment" && profile.provider === "gemini",
    );

    expect(envProfile).toBeTruthy();
    const envProfileId = envProfile?.id;
    expect(envProfileId).toBeTruthy();
    if (!envProfileId) {
      throw new Error("Expected an environment-backed Gemini profile.");
    }

    const nextState = await manager.setDefaultProfile(envProfileId);

    expect(nextState.activeProfileId).toBe(envProfileId);
    expect(nextState.selectedProvider).toBe("gemini");
    expect(nextState.profiles.find((profile) => profile.id === envProfileId)?.isDefault).toBe(true);
    expect(persistedDefaultProfileId).toBe(envProfileId);
  });

  test("saving from an environment profile creates a managed profile instead of mutating the env entry", async () => {
    process.env.OPENAI_API_KEY = "env-key";

    const manager = new LlmProfileManager({
      config: {
        ...TEST_CONFIG,
        llm: {
          ...TEST_CONFIG.llm,
          defaultProfileId: undefined,
          profiles: [],
        },
      },
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
    });

    const initialState = await manager.getState();
    const envProfile = initialState.profiles.find((profile) => profile.origin === "environment");

    const nextState = await manager.saveProfile({
      profileId: envProfile?.id,
      label: "Managed OpenAI",
      provider: "openai",
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

  test("saves profile metadata and stores API keys securely", async () => {
    const store = new MemoryCredentialStore("available");
    let persistedProfileId: string | undefined;

    const manager = new LlmProfileManager({
      config: {
        ...TEST_CONFIG,
        llm: {
          ...TEST_CONFIG.llm,
          defaultProfileId: undefined,
          profiles: [],
        },
      },
      credentialStore: store,
      writeConfig: async (config) => {
        persistedProfileId = config.defaultProfileId;
      },
    });

    const state = await manager.saveProfile({
      label: "Primary Gemini",
      provider: "gemini",
      model: "gemini-2.5-pro",
      apiKey: "secret-key",
      makeDefault: true,
    });

    expect(state.status).toBe("ready");
    const managedProfile = state.profiles.find((profile) => profile.origin === "managed");
    expect(managedProfile?.provider).toBe("gemini");
    expect(managedProfile?.keySource).toBe("secure_store");
    expect(persistedProfileId).toBe(managedProfile?.id);
    expect(store.secrets.get(managedProfile?.id ?? "")).toBe("secret-key");
  });

  test("treats CLI adapter profiles as ready model profiles without API keys", async () => {
    const manager = new LlmProfileManager({
      config: {
        ...TEST_CONFIG,
        llm: {
          ...TEST_CONFIG.llm,
          provider: "cli",
          model: "gpt-5.5",
          adapterId: "codex",
          apiKeyEnv: undefined,
          defaultProfileId: "codex-gpt55",
          profiles: [
            {
              id: "codex-gpt55",
              label: "Codex GPT-5.5",
              provider: "cli",
              model: "gpt-5.5",
              adapterId: "codex",
            },
          ],
        },
      },
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
    });

    const state = await manager.getState();

    expect(state.status).toBe("ready");
    expect(state.selectedProvider).toBe("cli");
    expect(state.selectedModel).toBe("gpt-5.5");
    expect(state.profiles[0]?.adapterId).toBe("codex");
    expect(state.profiles[0]?.keySource).toBe("not_required");
    expect(state.profiles[0]?.canDeleteApiKey).toBe(false);
  });

  test("persists adapter ids when saving external agent profiles", async () => {
    let persistedAdapterId: string | undefined;
    const manager = new LlmProfileManager({
      config: {
        ...TEST_CONFIG,
        llm: {
          ...TEST_CONFIG.llm,
          defaultProfileId: undefined,
          profiles: [],
        },
      },
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async (config) => {
        persistedAdapterId = config.profiles[0]?.adapterId;
      },
    });

    const state = await manager.saveProfile({
      label: "Codex GPT-5.5",
      provider: "cli",
      model: "gpt-5.5",
      adapterId: "codex",
      makeDefault: true,
    });

    expect(state.status).toBe("ready");
    expect(state.profiles[0]?.provider).toBe("cli");
    expect(state.profiles[0]?.adapterId).toBe("codex");
    expect(persistedAdapterId).toBe("codex");
  });

  test("marks invalid OpenRouter keys as not ready before a model turn starts", async () => {
    const manager = new LlmProfileManager({
      config: {
        ...TEST_CONFIG,
        llm: {
          ...TEST_CONFIG.llm,
          provider: "openrouter",
          model: "claude-opus-4-6",
          apiKeyEnv: "OPENROUTER_API_KEY",
          defaultProfileId: "openrouter-main",
          profiles: [
            {
              id: "openrouter-main",
              label: "OpenRouter Main",
              provider: "openrouter",
              model: "claude-opus-4-6",
              apiKeyEnv: "OPENROUTER_API_KEY",
              baseUrl: "https://openrouter.ai/api/v1",
            },
          ],
        },
      },
      credentialStore: new MemoryCredentialStore(
        "available",
        new Map([["openrouter-main", "sk-this-is-an-openai-key"]]),
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
