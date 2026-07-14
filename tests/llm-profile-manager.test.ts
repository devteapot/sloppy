import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CredentialStore, CredentialStoreStatus } from "../src/llm/credential-store";
import { getLlmRuntimeDescriptor } from "../src/llm/factory";
import {
  LlmConfigurationError,
  LlmProfileBindingRegistry,
  LlmProfileManager,
} from "../src/llm/profile-manager";
import { createRuntimeLlmProfileManager } from "../src/llm/runtime-config";
import { createDefaultChildSession, SessionRuntime } from "../src/session/runtime";
import { createStreamingAgentFactory } from "./helpers/agent-session-provider-harness";
import { createTestConfig } from "./helpers/config";

const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalOpenAIKey = process.env.OPENAI_API_KEY;
const originalGeminiKey = process.env.GEMINI_API_KEY;
const originalEndpoint = process.env.SLOPPY_LLM_ENDPOINT;
const originalProfile = process.env.SLOPPY_LLM_PROFILE;
const originalModel = process.env.SLOPPY_MODEL;
const originalReasoningEffort = process.env.SLOPPY_LLM_REASONING_EFFORT;
const originalCodexAuthPath = process.env.SLOPPY_CODEX_AUTH_PATH;
const originalTestHeader = process.env.TEST_LLM_AUTH_HEADER;
const originalSecuredKey = process.env.SLOPPY_TEST_MISSING_SECURED_KEY;

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

class BlockingStatusCredentialStore extends MemoryCredentialStore {
  private callCount = 0;

  constructor(
    private readonly signalStarted: () => void,
    private readonly allowed: Promise<void>,
  ) {
    super("available");
  }

  override async getStatus(): Promise<CredentialStoreStatus> {
    this.callCount += 1;
    if (this.callCount === 1) {
      this.signalStarted();
      await this.allowed;
    }
    return super.getStatus();
  }
}

class BlockingReadCredentialStore extends MemoryCredentialStore {
  private shouldBlock = true;

  constructor(
    secrets: Map<string, string>,
    private readonly signalStarted: () => void,
    private readonly allowed: Promise<void>,
  ) {
    super("available", secrets);
  }

  override async get(endpointId: string): Promise<string | null> {
    const value = await super.get(endpointId);
    if (this.shouldBlock) {
      this.shouldBlock = false;
      this.signalStarted();
      await this.allowed;
    }
    return value;
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
  restore("TEST_LLM_AUTH_HEADER", originalTestHeader);
  restore("SLOPPY_TEST_MISSING_SECURED_KEY", originalSecuredKey);
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

  test("runtime profile manager applies reasoning effort without rerouting", async () => {
    process.env.OPENAI_API_KEY = "router-key";
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_MODEL;
    process.env.SLOPPY_LLM_REASONING_EFFORT = "low";

    const manager = createRuntimeLlmProfileManager({
      config: TEST_CONFIG,
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
      env: process.env,
    });

    const state = await manager.getState();
    const activeProfile = state.profiles.find((profile) => profile.id === state.activeProfileId);

    expect(state.activeProfileId).toBe("openai-main");
    expect(activeProfile?.reasoningEffort).toBe("low");
    expect(activeProfile?.thinking.effectiveEffort).toBe("low");
  });

  test("applies top-level reasoning effort to managed profiles", async () => {
    process.env.OPENAI_API_KEY = "env-key";

    const manager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          reasoningEffort: "high",
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
    const activeProfile = state.profiles.find((profile) => profile.id === state.activeProfileId);

    expect(activeProfile?.reasoningEffort).toBe("high");
    expect(activeProfile?.thinking.effectiveEffort).toBe("high");
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

  test("rejects overlapping profile mutations while deletion is in flight", async () => {
    let signalWriteStarted: (() => void) | undefined;
    let allowWrite: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    const writeAllowed = new Promise<void>((resolve) => {
      allowWrite = resolve;
    });
    const manager = new LlmProfileManager({
      config: TEST_CONFIG,
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => {
        signalWriteStarted?.();
        await writeAllowed;
      },
    });

    const deletion = manager.deleteProfile("openai-main");
    await writeStarted;
    await expect(
      manager.saveProfile({ profileId: "openai-main", model: "gpt-5.4" }),
    ).rejects.toThrow("being modified");
    allowWrite?.();
    await expect(deletion).resolves.toMatchObject({ status: "needs_credentials" });
  });

  test("prevents a stale manager from resurrecting a profile deleted by a sibling", async () => {
    const config = createTestConfig({
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
    });
    const registry = new LlmProfileBindingRegistry();
    const initialRevision = registry.getRevision();
    const persistedProfileIds: string[][] = [];
    const createManager = () =>
      new LlmProfileManager({
        config,
        profileBindingRegistry: registry,
        expectedRevision: initialRevision,
        credentialStore: new MemoryCredentialStore("available"),
        writeConfig: async (llm) => {
          persistedProfileIds.push(llm.profiles.map((profile) => profile.id));
        },
      });
    const deletingManager = createManager();
    const staleManager = createManager();

    await deletingManager.deleteProfile("openai-main");

    staleManager.updateConfig(staleManager.getConfig());
    await expect(staleManager.setDefaultProfile("openai-alt")).rejects.toThrow(
      "configuration changed in another session",
    );
    expect(persistedProfileIds).toEqual([["openai-alt"]]);

    const reloadRevision = staleManager.captureConfigRevision();
    staleManager.updateConfig(deletingManager.getConfig(), {
      expectedRevision: reloadRevision,
    });
    await staleManager.setDefaultProfile("openai-alt");
    expect(persistedProfileIds).toEqual([["openai-alt"], ["openai-alt"]]);
  });

  test("does not stale sibling profile config after a credential-only mutation", async () => {
    const registry = new LlmProfileBindingRegistry();
    const initialRevision = registry.getRevision();
    const credentials = new MemoryCredentialStore("available", new Map([["openai", "shared-key"]]));
    const createManager = () =>
      new LlmProfileManager({
        config: TEST_CONFIG,
        profileBindingRegistry: registry,
        expectedRevision: initialRevision,
        credentialStore: credentials,
        writeConfig: async () => undefined,
      });
    const credentialManager = createManager();
    const siblingManager = createManager();

    await credentialManager.deleteApiKey("openai-main");

    await expect(siblingManager.setDefaultProfile("openai-main")).resolves.toMatchObject({
      activeProfileId: "openai-main",
    });
  });

  test("rejects config replacement while a profile mutation is in flight", async () => {
    let signalWriteStarted: (() => void) | undefined;
    let allowWrite: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    const writeAllowed = new Promise<void>((resolve) => {
      allowWrite = resolve;
    });
    const manager = new LlmProfileManager({
      config: TEST_CONFIG,
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => {
        signalWriteStarted?.();
        await writeAllowed;
      },
    });
    const reloadedConfig = createTestConfig({
      llm: {
        defaultProfileId: "reloaded",
        profiles: [
          {
            kind: "native",
            id: "reloaded",
            endpointId: "openai",
            model: "gpt-5.4-mini",
          },
        ],
      },
    });

    const deletion = manager.deleteProfile("openai-main");
    await writeStarted;
    expect(() => manager.updateConfig(reloadedConfig)).toThrow(
      "Cannot reload LLM configuration while profile 'openai-main' is being modified",
    );
    allowWrite?.();
    await deletion;

    expect(manager.getConfig().llm.profiles).toEqual([]);
  });

  test("retries adapter creation from one stable config snapshot after a routing reload", async () => {
    let signalStateReadStarted: (() => void) | undefined;
    let allowStateRead: (() => void) | undefined;
    const stateReadStarted = new Promise<void>((resolve) => {
      signalStateReadStarted = resolve;
    });
    const stateReadAllowed = new Promise<void>((resolve) => {
      allowStateRead = resolve;
    });
    const initialConfig = createTestConfig({
      llm: {
        endpoints: {
          legacy: {
            protocol: "openai-chat",
            baseUrl: "https://legacy-old.example.test/v1",
            auth: { type: "none" },
            models: { "old-model": {} },
          },
          modern: {
            protocol: "openai-responses",
            baseUrl: "https://modern.example.test/v1",
            auth: { type: "none" },
            models: { "new-model": {} },
          },
        },
        defaultProfileId: "routed",
        profiles: [
          {
            kind: "native",
            id: "routed",
            endpointId: "legacy",
            model: "old-model",
          },
        ],
      },
    });
    const reloadedConfig = createTestConfig({
      llm: {
        endpoints: {
          legacy: {
            protocol: "openai-chat",
            baseUrl: "https://legacy-new.example.test/v1",
            auth: { type: "none" },
            models: { "old-model": {} },
          },
          modern: {
            protocol: "openai-responses",
            baseUrl: "https://modern.example.test/v1",
            auth: { type: "none" },
            models: { "new-model": {} },
          },
        },
        defaultProfileId: "routed",
        profiles: [
          {
            kind: "native",
            id: "routed",
            endpointId: "modern",
            model: "new-model",
          },
        ],
      },
    });
    const manager = new LlmProfileManager({
      config: initialConfig,
      credentialStore: new BlockingStatusCredentialStore(
        () => signalStateReadStarted?.(),
        stateReadAllowed,
      ),
      writeConfig: async () => undefined,
    });

    const creatingAdapter = manager.createAdapter();
    await stateReadStarted;
    manager.updateConfig(reloadedConfig);
    allowStateRead?.();

    const adapter = await creatingAdapter;
    expect(getLlmRuntimeDescriptor(adapter)).toMatchObject({
      endpointId: "modern",
      protocol: "openai-responses",
      model: "new-model",
    });
    await expect(manager.createAdapter()).resolves.toBe(adapter);
  });

  test("invalidates adapter creation that overlaps a credential-only mutation", async () => {
    delete process.env.SLOPPY_TEST_MISSING_SECURED_KEY;
    let signalCredentialReadStarted: (() => void) | undefined;
    let allowCredentialRead: (() => void) | undefined;
    const credentialReadStarted = new Promise<void>((resolve) => {
      signalCredentialReadStarted = resolve;
    });
    const credentialReadAllowed = new Promise<void>((resolve) => {
      allowCredentialRead = resolve;
    });
    const config = createTestConfig({
      llm: {
        endpoints: {
          secured: {
            protocol: "openai-chat",
            baseUrl: "https://secured.example.test/v1",
            auth: { type: "env", env: "SLOPPY_TEST_MISSING_SECURED_KEY" },
            models: { "secured-model": {} },
          },
        },
        defaultProfileId: "secured",
        profiles: [
          {
            kind: "native",
            id: "secured",
            endpointId: "secured",
            model: "secured-model",
          },
        ],
      },
    });
    const credentialStore = new BlockingReadCredentialStore(
      new Map([["secured", "stored-secret"]]),
      () => signalCredentialReadStarted?.(),
      credentialReadAllowed,
    );
    const manager = new LlmProfileManager({
      config,
      credentialStore,
      writeConfig: async () => undefined,
    });

    const creatingAdapter = manager.createAdapter();
    await credentialReadStarted;
    await manager.deleteApiKey("secured");
    allowCredentialRead?.();

    await expect(creatingAdapter).rejects.toThrow("Add an API key");
  });

  test("rejects a reload snapshot captured before a committed profile mutation", async () => {
    const config = createTestConfig({
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
    });
    const persistedProfileIds: string[][] = [];
    let signalLoadStarted: (() => void) | undefined;
    let allowLoad: (() => void) | undefined;
    const loadStarted = new Promise<void>((resolve) => {
      signalLoadStarted = resolve;
    });
    const loadAllowed = new Promise<void>((resolve) => {
      allowLoad = resolve;
    });
    const manager = new LlmProfileManager({
      config,
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async (llm) => {
        persistedProfileIds.push(llm.profiles.map((profile) => profile.id));
      },
    });
    const staleReload = {
      ...config,
      llm: {
        ...config.llm,
        profiles: [...config.llm.profiles],
      },
    };
    const runtime = new SessionRuntime({
      config,
      llmProfileManager: manager,
      requiresLlmProfile: false,
      sessionPersistencePath: false,
      configReloader: async () => {
        signalLoadStarted?.();
        await loadAllowed;
        return staleReload;
      },
    });

    try {
      const reload = runtime.reloadConfig();
      await loadStarted;
      await manager.deleteProfile("openai-main");
      allowLoad?.();

      await expect(reload).rejects.toThrow("configuration changed while config was loading");
      await manager.setDefaultProfile("openai-alt");
      expect(persistedProfileIds).toEqual([["openai-alt"], ["openai-alt"]]);
    } finally {
      allowLoad?.();
      runtime.shutdown();
    }
  });

  test("rejects late construction from a profile snapshot loaded at an older revision", async () => {
    const config = createTestConfig({
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
    });
    const registry = new LlmProfileBindingRegistry();
    const loadedRevision = registry.getRevision();
    const deletingManager = new LlmProfileManager({
      config,
      profileBindingRegistry: registry,
      expectedRevision: loadedRevision,
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
    });

    await deletingManager.deleteProfile("openai-main");

    expect(
      () =>
        new LlmProfileManager({
          config,
          profileBindingRegistry: registry,
          expectedRevision: loadedRevision,
          credentialStore: new MemoryCredentialStore("available"),
          writeConfig: async () => undefined,
        }),
    ).toThrow("configuration changed while it was loading");
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
        plugins: {
          delegation: {
            acp: {
              enabled: true,
              adapters: {
                claude: { command: ["claude"] },
              },
            },
          },
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
    expect(state.profiles[0]?.ownsToolLoop).toBe(true);
  });

  test("keeps parent ACP profile readiness when a child runtime uses reduced config", async () => {
    const parentConfig = createTestConfig({
      llm: {
        defaultProfileId: "claude-sonnet",
        profiles: [
          {
            kind: "session-agent",
            id: "claude-sonnet",
            model: "sonnet",
            adapterId: "claude",
          },
        ],
      },
      plugins: {
        delegation: {
          acp: {
            enabled: true,
            adapters: {
              claude: { command: ["claude"] },
            },
          },
        },
      },
    });
    const childConfig = {
      ...parentConfig,
      plugins: {
        ...parentConfig.plugins,
        delegation: {
          ...parentConfig.plugins.delegation,
          enabled: false,
          acp: {
            ...parentConfig.plugins.delegation.acp,
            enabled: false,
            adapters: parentConfig.plugins.delegation.acp?.adapters ?? {},
          },
        },
      },
    };
    const manager = new LlmProfileManager({
      config: parentConfig,
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
    });
    const child = createDefaultChildSession({
      config: childConfig,
      sessionId: "reduced-config-child",
      title: "Reduced config child",
      providerId: "reduced-config-child",
      providerName: "Reduced config child",
      llmProfileManager: manager,
      agentFactory: createStreamingAgentFactory(),
    });

    try {
      await child.runtime.start();
      expect(manager.getConfig()).toBe(parentConfig);
      expect(child.runtime.config.plugins.delegation.acp?.enabled).toBe(false);
      await expect(manager.getState()).resolves.toMatchObject({
        status: "ready",
        activeProfileId: "claude-sonnet",
      });
    } finally {
      child.runtime.shutdown();
    }
  });

  test("does not apply native request-policy validation to session-agent profiles", async () => {
    const manager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          requestPolicy: {
            timeoutMs: 999,
            maxRetries: 2,
            baseRetryDelayMs: 500,
            maxRetryDelayMs: 10_000,
          },
          defaultProfileId: "claude-sonnet",
          profiles: [
            {
              kind: "session-agent",
              id: "claude-sonnet",
              model: "sonnet",
              adapterId: "claude",
            },
          ],
        },
        plugins: {
          delegation: {
            acp: {
              enabled: true,
              adapters: {
                claude: { command: ["claude"] },
              },
            },
          },
        },
      }),
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
    });

    const state = await manager.getState();

    expect(state.status).toBe("ready");
    expect(state.profiles[0]?.ready).toBe(true);
    expect(state.profiles[0]?.invalidReason).toBeUndefined();
  });

  test("marks session-agent profiles unready when their ACP adapter is unavailable", async () => {
    const manager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          defaultProfileId: "missing-acp",
          profiles: [
            {
              kind: "session-agent",
              id: "missing-acp",
              model: "sonnet",
              adapterId: "missing",
            },
          ],
        },
      }),
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
    });

    const state = await manager.getState();

    expect(state.status).toBe("needs_credentials");
    expect(state.profiles[0]?.ready).toBe(false);
    expect(state.profiles[0]?.invalidReason).toContain("plugins.delegation.acp.enabled");
  });

  test("accepts OpenAI Responses profiles during readiness checks", async () => {
    const manager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          endpoints: {
            responses: {
              protocol: "openai-responses",
              auth: { type: "none" },
              models: { "test-model": {} },
            },
          },
          defaultProfileId: "responses",
          profiles: [
            {
              kind: "native",
              id: "responses",
              endpointId: "responses",
              model: "test-model",
            },
          ],
        },
      }),
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
    });

    const state = await manager.getState();

    expect(state.profiles[0]?.ready).toBe(true);
    expect(state.profiles[0]?.protocol).toBe("openai-responses");
    const adapter = await manager.createAdapter();
    expect(getLlmRuntimeDescriptor(adapter)?.protocol).toBe("openai-responses");
  });

  test("rejects invalid native protocol auth combinations during readiness checks", async () => {
    const manager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          endpoints: {
            invalidCodex: {
              protocol: "openai-codex",
              auth: { type: "none" },
              models: { "test-model": {} },
            },
          },
          defaultProfileId: "invalid-codex",
          profiles: [
            {
              kind: "native",
              id: "invalid-codex",
              endpointId: "invalidCodex",
              model: "test-model",
            },
          ],
        },
      }),
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
    });

    const state = await manager.getState();

    expect(state.profiles[0]?.ready).toBe(false);
    expect(state.profiles[0]?.invalidReason).toContain("requires auth.type=codex");
    await expect(manager.createAdapter()).rejects.toThrow("requires auth.type=codex");
  });

  test("resolves env-backed endpoint headers and preserves runtime model metadata", async () => {
    process.env.TEST_LLM_AUTH_HEADER = "secret-bearer";
    const manager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          endpoints: {
            routed: {
              protocol: "openai-chat",
              baseUrl: "https://llm.example.test/v1",
              auth: { type: "none" },
              headers: { "x-route": "blue" },
              headerEnv: { Authorization: "TEST_LLM_AUTH_HEADER" },
              models: {
                "test-model": {
                  maxOutputTokens: 512,
                  capabilities: { tools: false, images: false },
                },
              },
            },
          },
          defaultProfileId: "routed",
          profiles: [
            {
              kind: "native",
              id: "routed",
              endpointId: "routed",
              model: "test-model",
            },
          ],
        },
      }),
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
    });

    const state = await manager.getState();
    const adapter = await manager.createAdapter();

    expect(state.profiles[0]).toMatchObject({
      ready: true,
      maxOutputTokens: 512,
      capabilities: { tools: false, images: false },
      ownsToolLoop: false,
    });
    expect(adapter.constructor.name).toBe("ResilientLlmAdapter");
    expect(getLlmRuntimeDescriptor(adapter)).toMatchObject({
      maxOutputTokens: 512,
      capabilities: { tools: false, images: false },
    });
  });

  test("marks missing env-backed or literal sensitive headers unready", async () => {
    delete process.env.TEST_LLM_AUTH_HEADER;
    const base = {
      protocol: "openai-chat" as const,
      baseUrl: "https://llm.example.test/v1",
      auth: { type: "none" as const },
      models: { "test-model": {} },
    };
    const missingEnvManager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          endpoints: {
            routed: {
              ...base,
              headerEnv: { Authorization: "TEST_LLM_AUTH_HEADER" },
            },
          },
          defaultProfileId: "routed",
          profiles: [
            {
              kind: "native",
              id: "routed",
              endpointId: "routed",
              model: "test-model",
            },
          ],
        },
      }),
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
    });
    const literalManager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          endpoints: {
            routed: {
              ...base,
              headers: { Authorization: "do-not-persist" },
            },
          },
          defaultProfileId: "routed",
          profiles: [
            {
              kind: "native",
              id: "routed",
              endpointId: "routed",
              model: "test-model",
            },
          ],
        },
      }),
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
    });

    expect((await missingEnvManager.getState()).message).toContain("TEST_LLM_AUTH_HEADER");
    expect((await literalManager.getState()).message).toContain("headerEnv");
  });

  test("marks programmatic credential-bearing HTTP endpoint config unready", async () => {
    process.env.TEST_LLM_AUTH_HEADER = "secret-bearer";
    const manager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          endpoints: {
            insecure: {
              protocol: "openai-chat",
              baseUrl: "http://llm.example.test/v1",
              auth: { type: "none" },
              headerEnv: { Authorization: "TEST_LLM_AUTH_HEADER" },
              models: { "test-model": {} },
            },
          },
          defaultProfileId: "insecure",
          profiles: [
            {
              kind: "native",
              id: "insecure",
              endpointId: "insecure",
              model: "test-model",
            },
          ],
        },
      }),
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
    });

    const state = await manager.getState();

    expect(state.profiles[0]?.ready).toBe(false);
    expect(state.profiles[0]?.invalidReason).toContain("must use https");
    await expect(manager.createAdapter()).rejects.toThrow("must use https");
  });

  test("marks native profiles with an invalid programmatic request policy unready", async () => {
    const manager = new LlmProfileManager({
      config: createTestConfig({
        llm: {
          requestPolicy: {
            timeoutMs: 999,
            maxRetries: 2,
            baseRetryDelayMs: 500,
            maxRetryDelayMs: 10_000,
          },
          endpoints: {
            local: {
              protocol: "openai-responses",
              auth: { type: "none" },
              models: { "test-model": {} },
            },
          },
          defaultProfileId: "local",
          profiles: [
            {
              kind: "native",
              id: "local",
              endpointId: "local",
              model: "test-model",
            },
          ],
        },
      }),
      credentialStore: new MemoryCredentialStore("available"),
      writeConfig: async () => undefined,
    });

    const state = await manager.getState();

    expect(state.profiles[0]?.ready).toBe(false);
    expect(state.profiles[0]?.invalidReason).toContain(
      "timeoutMs must be greater than or equal to 1000",
    );
    const failure = await manager.createAdapter().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LlmConfigurationError);
    expect(failure).toMatchObject({
      message: expect.stringContaining("timeoutMs must be greater than or equal to 1000"),
    });
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
                label: "Codex GPT-5.6 Sol",
                endpointId: "openai-codex",
                model: "gpt-5.6-sol",
                reasoningEffort: "max",
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
      expect(state.selectedModel).toBe("gpt-5.6-sol");
      expect(state.profiles[0]?.reasoningEffort).toBe("max");
      expect(state.profiles[0]?.contextWindowTokens).toBe(258_400);
      expect(state.profiles[0]?.maxOutputTokens).toBeUndefined();
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
        plugins: {
          delegation: {
            acp: {
              enabled: true,
              adapters: {
                claude: { command: ["claude"] },
              },
            },
          },
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
