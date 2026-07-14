import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeHomeLlmConfig } from "../src/config/persist";
import type { LlmConfig } from "../src/config/schema";

const originalHome = process.env.HOME;
const originalRoutedLlmToken = process.env.ROUTED_LLM_TOKEN;

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalRoutedLlmToken == null) {
    delete process.env.ROUTED_LLM_TOKEN;
  } else {
    process.env.ROUTED_LLM_TOKEN = originalRoutedLlmToken;
  }
});

function llmConfig(): LlmConfig {
  return {
    reasoningEffort: "medium",
    thinking: { enabled: false, display: "visible" },
    endpoints: {},
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
  } as unknown as LlmConfig;
}

describe("writeHomeLlmConfig", () => {
  test("preserves comments and unrelated sections in the home config", async () => {
    const home = await mkdtemp(join(tmpdir(), "sloppy-persist-home-"));
    process.env.HOME = home;
    await mkdir(join(home, ".sloppy"), { recursive: true });
    const configPath = join(home, ".sloppy", "config.yaml");
    await writeFile(
      configPath,
      [
        "# Top-of-file comment the user wrote by hand.",
        "plugins:",
        "  terminal:",
        "    # Keep the terminal sandboxed to the repo.",
        "    enabled: true",
        "llm:",
        "  defaultProfileId: stale-profile",
        "",
      ].join("\n"),
      "utf8",
    );

    await writeHomeLlmConfig(llmConfig());

    const written = await readFile(configPath, "utf8");
    expect(written).toContain("# Top-of-file comment the user wrote by hand.");
    expect(written).toContain("# Keep the terminal sandboxed to the repo.");
    expect(written).toContain("enabled: true");
    expect(written).toContain("defaultProfileId: openai-main");
    expect(written).not.toContain("stale-profile");
  });

  test("creates the config file when none exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "sloppy-persist-fresh-"));
    process.env.HOME = home;

    await writeHomeLlmConfig(llmConfig());

    const written = await readFile(join(home, ".sloppy", "config.yaml"), "utf8");
    expect(written).toContain("defaultProfileId: openai-main");
  });

  test("persists env-backed header names without persisting their secret values", async () => {
    const home = await mkdtemp(join(tmpdir(), "sloppy-persist-headers-"));
    process.env.HOME = home;
    process.env.ROUTED_LLM_TOKEN = "secret-header-value";
    const config = llmConfig();
    config.endpoints.routed = {
      protocol: "openai-chat",
      baseUrl: "https://llm.example.test/v1",
      auth: { type: "none" },
      headers: { "x-route": "blue" },
      headerEnv: { Authorization: "ROUTED_LLM_TOKEN" },
      models: { "test-model": {} },
    };

    await writeHomeLlmConfig(config);

    const written = await readFile(join(home, ".sloppy/config.yaml"), "utf8");
    expect(written).toContain("headerEnv:");
    expect(written).toContain("Authorization: ROUTED_LLM_TOKEN");
    expect(written).toContain("x-route: blue");
    expect(written).not.toContain("secret-header-value");
  });

  test("refuses to persist sensitive literal headers from programmatic config", async () => {
    const home = await mkdtemp(join(tmpdir(), "sloppy-persist-sensitive-header-"));
    process.env.HOME = home;
    const config = llmConfig();
    config.endpoints.routed = {
      protocol: "openai-chat",
      baseUrl: "https://llm.example.test/v1",
      auth: { type: "none" },
      headers: { Authorization: "Bearer must-not-be-written" },
      models: { "test-model": {} },
    };

    await expect(writeHomeLlmConfig(config)).rejects.toThrow(
      "Refusing to persist sensitive LLM header 'Authorization'",
    );
    expect(await Bun.file(join(home, ".sloppy/config.yaml")).exists()).toBe(false);
  });

  test("refuses to clobber a config file with invalid YAML", async () => {
    const home = await mkdtemp(join(tmpdir(), "sloppy-persist-bad-"));
    process.env.HOME = home;
    await mkdir(join(home, ".sloppy"), { recursive: true });
    const configPath = join(home, ".sloppy", "config.yaml");
    const broken = "plugins: [unclosed";
    await writeFile(configPath, broken, "utf8");

    await expect(writeHomeLlmConfig(llmConfig())).rejects.toThrow("failed to parse");
    expect(await readFile(configPath, "utf8")).toBe(broken);
  });
});
