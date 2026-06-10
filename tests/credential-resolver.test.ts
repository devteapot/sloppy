import { afterEach, describe, expect, test } from "bun:test";

import type { LlmEndpointConfig } from "../src/config/schema";
import {
  CredentialResolver,
  normalizeApiKey,
  validateApiKey,
} from "../src/llm/credential-resolver";
import type { CredentialStore, CredentialStoreStatus } from "../src/llm/credential-store";

const originalOpenAIKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (originalOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIKey;
  }
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

function envEndpoint(env = "OPENAI_API_KEY"): LlmEndpointConfig {
  return {
    label: "OpenAI",
    protocol: "openai-chat",
    auth: { type: "env", env },
    models: { "gpt-5.4": {} },
  } as LlmEndpointConfig;
}

function noAuthEndpoint(): LlmEndpointConfig {
  return {
    label: "Ollama",
    protocol: "openai-chat",
    auth: { type: "none" },
    models: { "llama3.2": {} },
  } as LlmEndpointConfig;
}

describe("CredentialResolver", () => {
  test("no-auth endpoints resolve as not_required and ready", async () => {
    const resolver = new CredentialResolver(new MemoryCredentialStore());
    const credential = await resolver.resolve(
      { id: "local", endpointId: "ollama" },
      noAuthEndpoint(),
    );
    expect(credential).toEqual({ keySource: "not_required", ready: true, hasKey: false });
  });

  test("environment-origin profiles resolve env keys before the secure store", async () => {
    process.env.OPENAI_API_KEY = "sk-env-key";
    const store = new MemoryCredentialStore();
    store.secrets.set("openai", "sk-stored-key");
    const resolver = new CredentialResolver(store);
    const credential = await resolver.resolve(
      { id: "env-openai", endpointId: "openai", origin: "environment" },
      envEndpoint(),
    );
    expect(credential.keySource).toBe("env");
    expect(credential.ready).toBe(true);
    expect(credential.apiKey).toBe("sk-env-key");
  });

  test("secure-store keys win over env for managed profiles", async () => {
    process.env.OPENAI_API_KEY = "sk-env-key";
    const store = new MemoryCredentialStore();
    store.secrets.set("openai", "sk-stored-key");
    const resolver = new CredentialResolver(store);
    const credential = await resolver.resolve(
      { id: "openai-main", endpointId: "openai", origin: "managed" },
      envEndpoint(),
    );
    expect(credential.keySource).toBe("secure_store");
    expect(credential.apiKey).toBe("sk-stored-key");
  });

  test("profile-scoped stored keys are used when no endpoint key exists", async () => {
    delete process.env.OPENAI_API_KEY;
    const store = new MemoryCredentialStore();
    store.secrets.set("openai-main", "sk-profile-key");
    const resolver = new CredentialResolver(store);
    const credential = await resolver.resolve(
      { id: "openai-main", endpointId: "openai", origin: "managed" },
      envEndpoint(),
    );
    expect(credential.keySource).toBe("secure_store");
    expect(credential.apiKey).toBe("sk-profile-key");
  });

  test("falls back to env keys for managed profiles without stored keys", async () => {
    process.env.OPENAI_API_KEY = "sk-env-only";
    const resolver = new CredentialResolver(new MemoryCredentialStore());
    const credential = await resolver.resolve(
      { id: "openai-main", endpointId: "openai", origin: "managed" },
      envEndpoint(),
    );
    expect(credential.keySource).toBe("env");
    expect(credential.apiKey).toBe("sk-env-only");
  });

  test("resolves missing when no credential source applies", async () => {
    delete process.env.OPENAI_API_KEY;
    const resolver = new CredentialResolver(new MemoryCredentialStore());
    const credential = await resolver.resolve(
      { id: "openai-main", endpointId: "openai", origin: "managed" },
      envEndpoint(),
    );
    expect(credential).toEqual({ keySource: "missing", ready: false, hasKey: false });
  });

  test("invalid openrouter keys surface invalidReason without ready", async () => {
    const store = new MemoryCredentialStore();
    store.secrets.set("openrouter", "not-a-real-key");
    const resolver = new CredentialResolver(store);
    const credential = await resolver.resolve(
      { id: "router", endpointId: "openrouter", origin: "managed" },
      {
        label: "OpenRouter",
        protocol: "openai-chat",
        auth: { type: "secure_store" },
        models: { "openai/gpt-5.4": {} },
      } as LlmEndpointConfig,
    );
    expect(credential.ready).toBe(false);
    expect(credential.hasKey).toBe(true);
    expect(credential.invalidReason).toContain("OpenRouter");
  });

  test("storeKey writes endpoint-scoped and clears stale profile-scoped keys", async () => {
    const store = new MemoryCredentialStore();
    store.secrets.set("openai-main", "sk-old-profile-key");
    const resolver = new CredentialResolver(store);
    await resolver.storeKey({ id: "openai-main", endpointId: "openai" }, "sk-new");
    expect(store.secrets.get("openai")).toBe("sk-new");
    expect(store.secrets.has("openai-main")).toBe(false);
  });

  test("deleteStoredKeys removes endpoint and profile keys", async () => {
    const store = new MemoryCredentialStore();
    store.secrets.set("openai", "sk-endpoint");
    store.secrets.set("openai-main", "sk-profile");
    const resolver = new CredentialResolver(store);
    await resolver.deleteStoredKeys({ id: "openai-main", endpointId: "openai" });
    expect(store.secrets.size).toBe(0);
  });

  test("profile removal keeps the endpoint key while other profiles use it", async () => {
    const store = new MemoryCredentialStore();
    store.secrets.set("openai", "sk-endpoint");
    const resolver = new CredentialResolver(store);
    await resolver.deleteStoredKeysForProfileRemoval(
      { kind: "native", id: "openai-a", endpointId: "openai", model: "gpt-5.4" },
      [{ kind: "native", id: "openai-b", endpointId: "openai", model: "gpt-5.4" }],
    );
    expect(store.secrets.get("openai")).toBe("sk-endpoint");

    await resolver.deleteStoredKeysForProfileRemoval(
      { kind: "native", id: "openai-b", endpointId: "openai", model: "gpt-5.4" },
      [],
    );
    expect(store.secrets.has("openai")).toBe(false);
  });
});

describe("api key validation helpers", () => {
  test("normalizeApiKey trims whitespace", () => {
    expect(normalizeApiKey("  sk-key \n")).toBe("sk-key");
  });

  test("validateApiKey only constrains openrouter prefixes", () => {
    expect(validateApiKey("openai", "anything")).toBeNull();
    expect(validateApiKey("openrouter", "sk-or-v1-abc")).toBeNull();
    expect(validateApiKey("openrouter", "bogus")).toContain("OpenRouter");
  });
});
