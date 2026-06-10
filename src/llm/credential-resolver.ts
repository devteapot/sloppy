import type { AnyLlmProfileConfig, LlmEndpointConfig, LlmProfileConfig } from "../config/schema";
import { endpointRequiresCredential, endpointUsesCodexAuth } from "./catalog";
import type { CredentialStore } from "./credential-store";
import { getCodexAuthStatus } from "./openai-codex";

export type LlmKeySource = "env" | "secure_store" | "missing" | "not_required" | "external_auth";

export type ResolvedCredential = {
  keySource: LlmKeySource;
  ready: boolean;
  hasKey: boolean;
  apiKey?: string;
  invalidReason?: string;
};

export type CredentialProfileRef = {
  id: string;
  endpointId?: string;
  origin?: "managed" | "environment" | "fallback";
};

export function normalizeApiKey(value: string): string {
  return value.trim();
}

export function validateApiKey(endpointId: string, apiKey: string): string | null {
  if (endpointId === "openrouter") {
    if (!apiKey.startsWith("sk-or-v1-") && !apiKey.startsWith("sk-or-")) {
      return "The configured OpenRouter API key does not look valid. OpenRouter keys usually start with sk-or-v1-.";
    }
  }

  return null;
}

/**
 * Resolves and manages endpoint credentials for LLM profiles. Owns the
 * credential resolution order: codex external auth, no-auth endpoints,
 * environment-origin profile env keys, the secure store, the generic env
 * fallback, then missing.
 */
export class CredentialResolver {
  constructor(private readonly credentialStore: CredentialStore) {}

  async resolve(
    profile: CredentialProfileRef,
    endpoint: LlmEndpointConfig,
  ): Promise<ResolvedCredential> {
    if (endpointUsesCodexAuth(endpoint)) {
      const status = await getCodexAuthStatus();
      return {
        keySource: status.available ? "external_auth" : "missing",
        ready: status.available,
        hasKey: status.available,
        invalidReason: status.reason,
      };
    }

    if (!endpointRequiresCredential(endpoint)) {
      return {
        keySource: "not_required",
        ready: true,
        hasKey: false,
      };
    }

    const endpointId = profile.endpointId;
    if (profile.origin === "environment" && endpoint.auth.type === "env") {
      const envCredential = this.resolveEnvCredential(endpoint.auth.env, endpointId);
      if (envCredential) {
        return envCredential;
      }
    }

    const storedKey = endpointId ? await this.getStoredKey(profile, endpointId) : null;
    if (storedKey && endpointId) {
      const normalizedApiKey = normalizeApiKey(storedKey);
      const invalidReason = validateApiKey(endpointId, normalizedApiKey);
      if (invalidReason) {
        return {
          keySource: "secure_store",
          ready: false,
          hasKey: true,
          invalidReason,
        };
      }

      return {
        keySource: "secure_store",
        ready: true,
        hasKey: true,
        apiKey: normalizedApiKey,
      };
    }

    if (endpoint.auth.type === "env") {
      const envCredential = this.resolveEnvCredential(endpoint.auth.env, endpointId);
      if (envCredential) {
        return envCredential;
      }
    }

    return {
      keySource: "missing",
      ready: false,
      hasKey: false,
    };
  }

  /**
   * Stores an endpoint credential. Keys are endpoint-scoped; a stale
   * profile-scoped key for the same profile is removed.
   */
  async storeKey(profile: { id: string; endpointId: string }, apiKey: string): Promise<void> {
    await this.credentialStore.set(profile.endpointId, apiKey);
    if (profile.id !== profile.endpointId) {
      await this.credentialStore.delete(profile.id);
    }
  }

  async deleteStoredKeys(profile: { id: string; endpointId: string }): Promise<void> {
    await this.credentialStore.delete(profile.endpointId);
    if (profile.id !== profile.endpointId) {
      await this.credentialStore.delete(profile.id);
    }
  }

  async deleteStoredKeysForProfileRemoval(
    profile: LlmProfileConfig,
    remainingProfiles: AnyLlmProfileConfig[],
  ): Promise<void> {
    const hasRemainingEndpointProfile = remainingProfiles.some(
      (candidate) => candidate.kind === "native" && candidate.endpointId === profile.endpointId,
    );

    if (profile.id !== profile.endpointId) {
      await this.credentialStore.delete(profile.id);
    }
    if (!hasRemainingEndpointProfile) {
      await this.credentialStore.delete(profile.endpointId);
    }
  }

  private async getStoredKey(profile: { id: string }, endpointId: string): Promise<string | null> {
    const endpointKey = await this.credentialStore.get(endpointId);
    if (endpointKey || profile.id === endpointId) {
      return endpointKey;
    }

    return this.credentialStore.get(profile.id);
  }

  private resolveEnvCredential(env: string, endpointId?: string): ResolvedCredential | null {
    const envKey = Bun.env[env];
    if (!envKey || !endpointId) {
      return null;
    }
    const normalizedApiKey = normalizeApiKey(envKey);
    const invalidReason = validateApiKey(endpointId, normalizedApiKey);
    if (invalidReason) {
      return {
        keySource: "env",
        ready: false,
        hasKey: true,
        invalidReason,
      };
    }

    return {
      keySource: "env",
      ready: true,
      hasKey: true,
      apiKey: normalizedApiKey,
    };
  }
}
