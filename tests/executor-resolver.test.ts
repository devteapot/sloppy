import { describe, expect, test } from "bun:test";

import type { SloppyConfig } from "../src/config/schema";
import { LlmConfigurationError } from "../src/llm/profile-manager";
import { ExecutorResolver } from "../src/runtime/delegation/executor-resolver";

function buildConfig(overrides?: {
  profiles?: SloppyConfig["llm"]["profiles"];
  acp?: SloppyConfig["providers"]["delegation"]["acp"];
}): SloppyConfig {
  return {
    llm: {
      provider: "anthropic",
      model: "claude",
      maxTokens: 4096,
      profiles: overrides?.profiles ?? [
        { id: "anthropic-main", provider: "anthropic", model: "claude" },
        { id: "openai-cheap", provider: "openai", model: "gpt-mini" },
      ],
    },
    agent: {} as SloppyConfig["agent"],
    maxToolResultSize: 4096,
    providers: {
      builtin: {} as SloppyConfig["providers"]["builtin"],
      discovery: { enabled: false, paths: [] },
      terminal: {} as SloppyConfig["providers"]["terminal"],
      filesystem: {} as SloppyConfig["providers"]["filesystem"],
      memory: {} as SloppyConfig["providers"]["memory"],
      skills: {} as SloppyConfig["providers"]["skills"],
      web: {} as SloppyConfig["providers"]["web"],
      browser: {} as SloppyConfig["providers"]["browser"],
      cron: {} as SloppyConfig["providers"]["cron"],
      messaging: {} as SloppyConfig["providers"]["messaging"],
      delegation: {
        maxAgents: 10,
        acp: overrides?.acp,
      },
      orchestration: {} as SloppyConfig["providers"]["orchestration"],
      vision: {} as SloppyConfig["providers"]["vision"],
    },
  } as SloppyConfig;
}

describe("ExecutorResolver", () => {
  test("undefined binding resolves to llm with no explicit profile", () => {
    const resolver = new ExecutorResolver({ config: buildConfig() });
    const resolved = resolver.resolve(undefined);
    expect(resolved).toEqual({ kind: "llm" });
  });

  test("llm binding with known profileId resolves with profile + override", () => {
    const resolver = new ExecutorResolver({ config: buildConfig() });
    const resolved = resolver.resolve({
      kind: "llm",
      profileId: "openai-cheap",
      modelOverride: "gpt-other",
    });
    expect(resolved).toEqual({
      kind: "llm",
      profileId: "openai-cheap",
      modelOverride: "gpt-other",
    });
  });

  test("llm binding with unknown profileId throws", () => {
    const resolver = new ExecutorResolver({ config: buildConfig() });
    expect(() => resolver.resolve({ kind: "llm", profileId: "missing" })).toThrow(
      LlmConfigurationError,
    );
  });

  test("acp binding resolves to adapter when enabled", () => {
    const resolver = new ExecutorResolver({
      config: buildConfig({
        acp: {
          enabled: true,
          defaultTimeoutMs: 5000,
          adapters: {
            fake: { command: ["fake-acp"], timeoutMs: 1000 },
          },
        },
      }),
    });
    const resolved = resolver.resolve({ kind: "acp", adapterId: "fake" });
    expect(resolved).toMatchObject({
      kind: "acp",
      adapterId: "fake",
      defaultTimeoutMs: 5000,
    });
    if (resolved.kind === "acp") {
      expect(resolved.adapter.command).toEqual(["fake-acp"]);
    }
  });

  test("acp binding with timeoutMs override carries through", () => {
    const resolver = new ExecutorResolver({
      config: buildConfig({
        acp: {
          enabled: true,
          adapters: { fake: { command: ["fake-acp"] } },
        },
      }),
    });
    const resolved = resolver.resolve({
      kind: "acp",
      adapterId: "fake",
      timeoutMs: 2500,
    });
    if (resolved.kind !== "acp") throw new Error("expected acp");
    expect(resolved.timeoutMs).toBe(2500);
  });

  test("acp binding when adapter unknown throws", () => {
    const resolver = new ExecutorResolver({
      config: buildConfig({
        acp: { enabled: true, adapters: {} },
      }),
    });
    expect(() => resolver.resolve({ kind: "acp", adapterId: "nope" })).toThrow(
      LlmConfigurationError,
    );
  });

  test("acp binding when ACP disabled throws", () => {
    const resolver = new ExecutorResolver({
      config: buildConfig({
        acp: { enabled: false, adapters: { fake: { command: ["fake-acp"] } } },
      }),
    });
    expect(() => resolver.resolve({ kind: "acp", adapterId: "fake" })).toThrow(
      LlmConfigurationError,
    );
  });

  test("acp binding when no acp config at all throws", () => {
    const resolver = new ExecutorResolver({ config: buildConfig() });
    expect(() => resolver.resolve({ kind: "acp", adapterId: "fake" })).toThrow(
      LlmConfigurationError,
    );
  });
});
