import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config/load";

const tempPaths: string[] = [];
const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalProvider = process.env.SLOPPY_LLM_PROVIDER;
const originalModel = process.env.SLOPPY_MODEL;
const originalReasoningEffort = process.env.SLOPPY_LLM_REASONING_EFFORT;
const originalAdapterId = process.env.SLOPPY_LLM_ADAPTER_ID;
const originalBaseUrl = process.env.SLOPPY_LLM_BASE_URL;
const originalApiKeyEnv = process.env.SLOPPY_LLM_API_KEY_ENV;
const originalMaxIterations = process.env.SLOPPY_MAX_ITERATIONS;

async function createTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(path);
  return path;
}

async function writeConfig(root: string, contents: string): Promise<void> {
  const configDir = join(root, ".sloppy");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.yaml"), contents, "utf8");
}

afterEach(async () => {
  process.chdir(originalCwd);

  if (originalHome == null) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
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

  if (originalReasoningEffort == null) {
    delete process.env.SLOPPY_LLM_REASONING_EFFORT;
  } else {
    process.env.SLOPPY_LLM_REASONING_EFFORT = originalReasoningEffort;
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

  if (originalMaxIterations == null) {
    delete process.env.SLOPPY_MAX_ITERATIONS;
  } else {
    process.env.SLOPPY_MAX_ITERATIONS = originalMaxIterations;
  }

  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (!path) {
      continue;
    }
    await rm(path, { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  test("applies provider-specific defaults for OpenRouter", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(workspace, "llm:\n  provider: openrouter\n");

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_PROVIDER;
    delete process.env.SLOPPY_MODEL;
    delete process.env.SLOPPY_LLM_ADAPTER_ID;
    delete process.env.SLOPPY_LLM_BASE_URL;
    delete process.env.SLOPPY_LLM_API_KEY_ENV;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.llm.provider).toBe("openrouter");
    expect(config.llm.model).toBe("openai/gpt-5.4");
    expect(config.llm.apiKeyEnv).toBe("OPENROUTER_API_KEY");
    expect(config.llm.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  test("applies provider-specific defaults for Gemini", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(workspace, "llm:\n  provider: gemini\n");

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_PROVIDER;
    delete process.env.SLOPPY_MODEL;
    delete process.env.SLOPPY_LLM_ADAPTER_ID;
    delete process.env.SLOPPY_LLM_BASE_URL;
    delete process.env.SLOPPY_LLM_API_KEY_ENV;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.llm.provider).toBe("gemini");
    expect(config.llm.model).toBe("gemini-2.5-pro");
    expect(config.llm.apiKeyEnv).toBe("GEMINI_API_KEY");
    expect(config.llm.baseUrl).toBeUndefined();
  });

  test("loads native OpenAI Codex profiles with reasoning effort", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(
      workspace,
      [
        "llm:",
        "  provider: openai-codex",
        "  model: gpt-5.5",
        "  reasoningEffort: low",
        "  profiles:",
        "    - id: codex-native",
        "      label: Codex Native",
        "      provider: openai-codex",
        "      model: gpt-5.5",
        "      reasoningEffort: low",
      ].join("\n"),
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_PROVIDER;
    delete process.env.SLOPPY_MODEL;
    delete process.env.SLOPPY_LLM_REASONING_EFFORT;
    delete process.env.SLOPPY_LLM_ADAPTER_ID;
    delete process.env.SLOPPY_LLM_BASE_URL;
    delete process.env.SLOPPY_LLM_API_KEY_ENV;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.llm.provider).toBe("openai-codex");
    expect(config.llm.model).toBe("gpt-5.5");
    expect(config.llm.reasoningEffort).toBe("low");
    expect(config.llm.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(config.llm.apiKeyEnv).toBeUndefined();
    expect(config.llm.profiles[0]?.reasoningEffort).toBe("low");
  });

  test("applies env overrides for provider and base URL", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(workspace, "llm:\n  provider: anthropic\n");

    process.env.HOME = home;
    process.env.SLOPPY_LLM_PROVIDER = "ollama";
    process.env.SLOPPY_LLM_BASE_URL = "http://127.0.0.1:11434/v1";
    delete process.env.SLOPPY_LLM_API_KEY_ENV;
    delete process.env.SLOPPY_MODEL;
    delete process.env.SLOPPY_LLM_ADAPTER_ID;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.llm.provider).toBe("ollama");
    expect(config.llm.model).toBe("llama3.2");
    expect(config.llm.apiKeyEnv).toBeUndefined();
    expect(config.llm.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });

  test("applies env override for API key env name", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(workspace, "llm:\n  provider: openai\n");

    process.env.HOME = home;
    process.env.SLOPPY_LLM_API_KEY_ENV = "LITELLM_API_KEY";
    delete process.env.SLOPPY_LLM_PROVIDER;
    delete process.env.SLOPPY_MODEL;
    delete process.env.SLOPPY_LLM_ADAPTER_ID;
    delete process.env.SLOPPY_LLM_BASE_URL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.llm.provider).toBe("openai");
    expect(config.llm.apiKeyEnv).toBe("LITELLM_API_KEY");
  });

  test("expands ~ in skills.skillsDir to the user's home directory", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_PROVIDER;
    delete process.env.SLOPPY_MODEL;
    delete process.env.SLOPPY_LLM_ADAPTER_ID;
    delete process.env.SLOPPY_LLM_BASE_URL;
    delete process.env.SLOPPY_LLM_API_KEY_ENV;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.providers.skills.skillsDir).toBe(join(home, ".sloppy/skills"));
    expect(config.providers.skills.builtinSkillsDir).toBe(join(process.cwd(), "skills"));
  });

  test("normalizes external skill directories", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(
      workspace,
      [
        "providers:",
        "  skills:",
        "    externalDirs:",
        "      - ~/team-skills",
        "      - ./vendor-skills",
      ].join("\n"),
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_PROVIDER;
    delete process.env.SLOPPY_MODEL;
    delete process.env.SLOPPY_LLM_ADAPTER_ID;
    delete process.env.SLOPPY_LLM_BASE_URL;
    delete process.env.SLOPPY_LLM_API_KEY_ENV;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.providers.skills.externalDirs).toEqual([
      join(home, "team-skills"),
      join(process.cwd(), "vendor-skills"),
    ]);
  });

  test("applies env override for max iterations", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");

    process.env.HOME = home;
    process.env.SLOPPY_MAX_ITERATIONS = "80";
    delete process.env.SLOPPY_LLM_PROVIDER;
    delete process.env.SLOPPY_MODEL;
    delete process.env.SLOPPY_LLM_ADAPTER_ID;
    delete process.env.SLOPPY_LLM_BASE_URL;
    delete process.env.SLOPPY_LLM_API_KEY_ENV;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.agent.maxIterations).toBe(80);
  });

  test("loads ACP adapter capabilities with conservative defaults", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(
      workspace,
      [
        "providers:",
        "  delegation:",
        "    acp:",
        "      enabled: true",
        "      adapters:",
        "        fake:",
        '          command: ["fake-acp"]',
        "          capabilities:",
        "            shell_allowed: true",
      ].join("\n"),
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_PROVIDER;
    delete process.env.SLOPPY_MODEL;
    delete process.env.SLOPPY_LLM_ADAPTER_ID;
    delete process.env.SLOPPY_LLM_BASE_URL;
    delete process.env.SLOPPY_LLM_API_KEY_ENV;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.providers.delegation.acp?.adapters.fake.capabilities).toEqual({
      spawn_allowed: false,
      shell_allowed: true,
      network_allowed: false,
      filesystem_reads_allowed: true,
      filesystem_writes_allowed: false,
    });
    expect(config.providers.delegation.acp?.adapters.fake.inheritEnv ?? false).toBe(false);
  });
});
