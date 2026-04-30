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
const originalBaseUrl = process.env.SLOPPY_LLM_BASE_URL;
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

  if (originalBaseUrl == null) {
    delete process.env.SLOPPY_LLM_BASE_URL;
  } else {
    process.env.SLOPPY_LLM_BASE_URL = originalBaseUrl;
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
    delete process.env.SLOPPY_LLM_BASE_URL;
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
    delete process.env.SLOPPY_LLM_BASE_URL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.llm.provider).toBe("gemini");
    expect(config.llm.model).toBe("gemini-2.5-pro");
    expect(config.llm.apiKeyEnv).toBe("GEMINI_API_KEY");
    expect(config.llm.baseUrl).toBeUndefined();
  });

  test("applies env overrides for provider and base URL", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(workspace, "llm:\n  provider: anthropic\n");

    process.env.HOME = home;
    process.env.SLOPPY_LLM_PROVIDER = "ollama";
    process.env.SLOPPY_LLM_BASE_URL = "http://127.0.0.1:11434/v1";
    delete process.env.SLOPPY_MODEL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.llm.provider).toBe("ollama");
    expect(config.llm.model).toBe("llama3.2");
    expect(config.llm.apiKeyEnv).toBeUndefined();
    expect(config.llm.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });

  test("expands ~ in skills.skillsDir to the user's home directory", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_PROVIDER;
    delete process.env.SLOPPY_MODEL;
    delete process.env.SLOPPY_LLM_BASE_URL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.providers.skills.skillsDir).toBe(join(home, ".hermes/skills"));
    expect(config.providers.orchestration.finalAuditCommandTimeoutMs).toBe(30000);
  });

  test("loads orchestration budget config", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(
      workspace,
      "providers:\n  orchestration:\n    budget:\n      wallTimeMs: 2500\n      retriesPerSlice: 2\n      tokenLimit: 50000\n      costUsd: 1.25\n",
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_PROVIDER;
    delete process.env.SLOPPY_MODEL;
    delete process.env.SLOPPY_LLM_BASE_URL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.providers.orchestration.budget?.wallTimeMs).toBe(2500);
    expect(config.providers.orchestration.budget?.retriesPerSlice).toBe(2);
    expect(config.providers.orchestration.budget?.tokenLimit).toBe(50000);
    expect(config.providers.orchestration.budget?.costUsd).toBe(1.25);
  });

  test("loads orchestration gate policy config", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(
      workspace,
      [
        "providers:",
        "  orchestration:",
        "    policy:",
        "      gates:",
        "        sliceGate: policy",
        "      goals:",
        "        goal-importer:",
        "          gates:",
        "            sliceGate: user",
      ].join("\n"),
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_PROVIDER;
    delete process.env.SLOPPY_MODEL;
    delete process.env.SLOPPY_LLM_BASE_URL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.providers.orchestration.policy?.gates.sliceGate).toBe("policy");
    expect(config.providers.orchestration.policy?.goals["goal-importer"]?.gates.sliceGate).toBe(
      "user",
    );
  });

  test("loads orchestration guardrail config", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(
      workspace,
      [
        "providers:",
        "  orchestration:",
        "    guardrails:",
        "      repeatedFailureLimit: 2",
        "      blastRadius:",
        "        maxFilesModified: 3",
        "        maxDepsAdded: 1",
        "        maxExternalCalls: 2",
        "        publicSurfaceDeltaRequiresGate: true",
        "    digest:",
        "      cadence: on_escalation",
      ].join("\n"),
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_PROVIDER;
    delete process.env.SLOPPY_MODEL;
    delete process.env.SLOPPY_LLM_BASE_URL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.providers.orchestration.guardrails?.repeatedFailureLimit).toBe(2);
    expect(config.providers.orchestration.guardrails?.blastRadius.maxFilesModified).toBe(3);
    expect(config.providers.orchestration.guardrails?.blastRadius.maxDepsAdded).toBe(1);
    expect(config.providers.orchestration.guardrails?.blastRadius.maxExternalCalls).toBe(2);
    expect(
      config.providers.orchestration.guardrails?.blastRadius.publicSurfaceDeltaRequiresGate,
    ).toBe(true);
    expect(config.providers.orchestration.digest?.cadence).toBe("on_escalation");
  });

  test("applies env override for max iterations", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");

    process.env.HOME = home;
    process.env.SLOPPY_MAX_ITERATIONS = "80";
    delete process.env.SLOPPY_LLM_PROVIDER;
    delete process.env.SLOPPY_MODEL;
    delete process.env.SLOPPY_LLM_BASE_URL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.agent.maxIterations).toBe(80);
  });
});
