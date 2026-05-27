import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

import {
  createDefaultConfig,
  loadConfig,
  loadConfigFromLayerPaths,
  loadScopedConfig,
} from "../src/config/load";
import { writeHomeLlmConfig } from "../src/config/persist";
import { activeFirstPartyPlugins } from "../src/plugins/first-party/catalog";

const tempPaths: string[] = [];
const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalEndpoint = process.env.SLOPPY_LLM_ENDPOINT;
const originalProfile = process.env.SLOPPY_LLM_PROFILE;
const originalModel = process.env.SLOPPY_MODEL;
const originalReasoningEffort = process.env.SLOPPY_LLM_REASONING_EFFORT;
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

  if (originalEndpoint == null) {
    delete process.env.SLOPPY_LLM_ENDPOINT;
  } else {
    process.env.SLOPPY_LLM_ENDPOINT = originalEndpoint;
  }

  if (originalProfile == null) {
    delete process.env.SLOPPY_LLM_PROFILE;
  } else {
    process.env.SLOPPY_LLM_PROFILE = originalProfile;
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
  test("default runtime enables apps, terminal, and filesystem plugins", () => {
    const config = createDefaultConfig(originalCwd);
    expect(activeFirstPartyPlugins(config).map((plugin) => plugin.id)).toEqual([
      "apps",
      "terminal",
      "filesystem",
    ]);
    expect(config.plugins["persistent-goal"].enabled).toBe(false);
    expect(config.plugins.memory.enabled).toBe(false);
    expect(config.plugins.skills.enabled).toBe(false);
  });

  test("checked-in config example is loadable", async () => {
    const home = await createTempDir("sloppy-home-");
    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_LLM_PROFILE;
    delete process.env.SLOPPY_MODEL;
    delete process.env.SLOPPY_LLM_REASONING_EFFORT;
    delete process.env.SLOPPY_MAX_ITERATIONS;

    const config = await loadConfigFromLayerPaths(
      [resolve(originalCwd, ".sloppy/config.example.yaml")],
      { cwd: originalCwd },
    );

    expect(config.plugins["meta-runtime"].enabled).toBe(true);
    expect(config.plugins.messaging.enabled).toBe(true);
    expect(config.plugins.delegation.enabled).toBe(true);
    expect(config.plugins.delegation.acp?.enabled).toBe(true);
    expect(config.plugins.mcp.enabled).toBe(true);
    expect(config.plugins.a2a.enabled).toBe(true);
    expect(config.plugins.workspaces.enabled).toBe(true);
    expect(config.providers.discovery.enabled).toBe(true);
  });

  test("README plugin config example parses without duplicate keys", async () => {
    const readme = await readFile(resolve(originalCwd, "README.md"), "utf8");
    const sectionStart = readme.indexOf("First-party plugins default to the lean core");
    const blockStart = readme.indexOf("```yaml", sectionStart);
    const blockEnd = readme.indexOf("```", blockStart + "```yaml".length);
    const block = readme.slice(blockStart + "```yaml".length, blockEnd).trim();
    const parsed = YAML.parse(block) as {
      plugins?: {
        "meta-runtime"?: {
          enabled?: boolean;
          globalRoot?: string;
          workspaceRoot?: string;
        };
      };
    };

    expect(parsed.plugins?.["meta-runtime"]).toEqual({
      enabled: true,
      globalRoot: "~/.sloppy/meta-runtime",
      workspaceRoot: ".sloppy/meta-runtime",
    });
  });

  test("applies built-in endpoint defaults for OpenRouter profiles", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(
      workspace,
      [
        "llm:",
        "  defaultProfileId: openrouter-main",
        "  profiles:",
        "    - id: openrouter-main",
        "      endpointId: openrouter",
        "      model: openai/gpt-5.4",
      ].join("\n"),
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_LLM_PROFILE;
    delete process.env.SLOPPY_MODEL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.llm.profiles[0]).toMatchObject({
      endpointId: "openrouter",
      model: "openai/gpt-5.4",
    });
    expect(config.llm.endpoints.openrouter?.auth).toEqual({
      type: "env",
      env: "OPENROUTER_API_KEY",
    });
    expect(config.llm.endpoints.openrouter?.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  test("applies built-in endpoint defaults for Gemini profiles", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(
      workspace,
      [
        "llm:",
        "  defaultProfileId: gemini-main",
        "  profiles:",
        "    - id: gemini-main",
        "      endpointId: gemini",
        "      model: gemini-2.5-pro",
      ].join("\n"),
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_LLM_PROFILE;
    delete process.env.SLOPPY_MODEL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.llm.profiles[0]).toMatchObject({
      endpointId: "gemini",
      model: "gemini-2.5-pro",
    });
    expect(config.llm.endpoints.gemini?.auth).toEqual({ type: "env", env: "GEMINI_API_KEY" });
    expect(config.llm.endpoints.gemini?.baseUrl).toBeUndefined();
  });

  test("loads native OpenAI Codex profiles with reasoning effort", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(
      workspace,
      [
        "llm:",
        "  reasoningEffort: low",
        "  defaultProfileId: codex-native",
        "  profiles:",
        "    - id: codex-native",
        "      label: Codex Native",
        "      endpointId: openai-codex",
        "      model: gpt-5.5",
        "      reasoningEffort: low",
      ].join("\n"),
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_LLM_PROFILE;
    delete process.env.SLOPPY_MODEL;
    delete process.env.SLOPPY_LLM_REASONING_EFFORT;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.llm.reasoningEffort).toBe("low");
    expect(config.llm.profiles[0]).toMatchObject({
      endpointId: "openai-codex",
      model: "gpt-5.5",
      reasoningEffort: "low",
    });
    expect(config.llm.endpoints["openai-codex"]?.baseUrl).toBe(
      "https://chatgpt.com/backend-api/codex",
    );
    expect(config.llm.endpoints["openai-codex"]?.auth).toEqual({ type: "codex" });
  });

  test("persists runtime endpoint defaults without schema-only fields", async () => {
    const home = await createTempDir("sloppy-home-");
    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_LLM_PROFILE;
    delete process.env.SLOPPY_MODEL;
    delete process.env.SLOPPY_LLM_REASONING_EFFORT;

    await writeHomeLlmConfig(createDefaultConfig(originalCwd).llm);

    const homeConfigPath = join(home, ".sloppy/config.yaml");
    const persisted = await readFile(homeConfigPath, "utf8");
    const parsed = YAML.parse(persisted) as { llm?: { endpoints?: unknown } };

    expect(persisted).not.toContain("defaultModel");
    expect(parsed.llm?.endpoints).toEqual({});

    const config = await loadConfigFromLayerPaths([homeConfigPath], { cwd: originalCwd });
    expect(config.llm.endpoints.openai?.models["gpt-5.4"]).toBeDefined();
  });

  test("loads endpoint configs persisted with runtime-only defaultModel", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(
      workspace,
      [
        "llm:",
        "  endpoints:",
        "    openai:",
        "      protocol: openai-chat",
        "      defaultModel: gpt-5.4",
        "      auth:",
        "        type: env",
        "        env: OPENAI_API_KEY",
        "      models:",
        "        gpt-5.4: {}",
        "  defaultProfileId: openai-main",
        "  profiles:",
        "    - id: openai-main",
        "      endpointId: openai",
        "      model: gpt-5.4",
      ].join("\n"),
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_LLM_PROFILE;
    delete process.env.SLOPPY_MODEL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.llm.endpoints.openai?.models["gpt-5.4"]).toBeDefined();
  });

  test("applies env overrides for endpoint and model", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(workspace, "llm:\n  profiles: []\n");

    process.env.HOME = home;
    process.env.SLOPPY_LLM_ENDPOINT = "ollama";
    process.env.SLOPPY_MODEL = "local/test-model";
    delete process.env.SLOPPY_LLM_PROFILE;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.llm.defaultProfileId).toBe("runtime");
    expect(config.llm.profiles).toEqual([
      {
        kind: "native",
        id: "runtime",
        label: "Runtime Override",
        endpointId: "ollama",
        model: "local/test-model",
      },
    ]);
    expect(config.llm.endpoints.ollama?.baseUrl).toBe("http://localhost:11434/v1");
  });

  test("applies model env overrides on the active native endpoint", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(
      workspace,
      [
        "llm:",
        "  defaultProfileId: openrouter-main",
        "  profiles:",
        "    - id: openrouter-main",
        "      endpointId: openrouter",
        "      model: openai/gpt-5.4",
      ].join("\n"),
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_LLM_PROFILE;
    process.env.SLOPPY_MODEL = "openai/gpt-custom";
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.llm.defaultProfileId).toBe("runtime");
    expect(config.llm.profiles).toEqual([
      {
        kind: "native",
        id: "runtime",
        label: "Runtime Override",
        endpointId: "openrouter",
        model: "openai/gpt-custom",
      },
    ]);
  });

  test("normalizes legacy top-level LLM provider config", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(
      workspace,
      [
        "llm:",
        "  provider: openrouter",
        "  model: openai/gpt-5.4",
        "  apiKeyEnv: OPENROUTER_API_KEY",
        "  baseUrl: https://openrouter.ai/api/v1",
        "  contextWindowTokens: 123456",
      ].join("\n"),
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_LLM_PROFILE;
    delete process.env.SLOPPY_MODEL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.llm.defaultProfileId).toBe("default");
    expect(config.llm.profiles[0]).toMatchObject({
      kind: "native",
      id: "default",
      endpointId: "openrouter",
      model: "openai/gpt-5.4",
    });
    expect(config.llm.endpoints.openrouter?.auth).toEqual({
      type: "env",
      env: "OPENROUTER_API_KEY",
    });
    expect(config.llm.endpoints.openrouter?.models["openai/gpt-5.4"]?.contextWindowTokens).toBe(
      123456,
    );
  });

  test("normalizes legacy LLM profile endpoint fields", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(
      workspace,
      [
        "llm:",
        "  provider: anthropic",
        "  defaultProfileId: custom-openai",
        "  profiles:",
        "    - id: custom-openai",
        "      label: Custom OpenAI",
        "      provider: openai",
        "      model: custom/gpt",
        "      apiKeyEnv: CUSTOM_OPENAI_KEY",
        "      baseUrl: https://llm.example.test/v1",
        "      contextWindowTokens: 98765",
      ].join("\n"),
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_LLM_PROFILE;
    delete process.env.SLOPPY_MODEL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.llm.defaultProfileId).toBe("custom-openai");
    expect(config.llm.profiles[0]).toMatchObject({
      kind: "native",
      id: "custom-openai",
      label: "Custom OpenAI",
      endpointId: "custom-openai",
      model: "custom/gpt",
    });
    expect(config.llm.endpoints["custom-openai"]).toMatchObject({
      protocol: "openai-chat",
      baseUrl: "https://llm.example.test/v1",
      auth: { type: "env", env: "CUSTOM_OPENAI_KEY" },
    });
    expect(config.llm.endpoints["custom-openai"]?.models["custom/gpt"]?.contextWindowTokens).toBe(
      98765,
    );
  });

  test("loads custom endpoint auth env names", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(
      workspace,
      [
        "llm:",
        "  endpoints:",
        "    local-router:",
        "      protocol: openai-chat",
        "      baseUrl: http://sloppy-mba.local:8001/v1",
        "      auth:",
        "        type: env",
        "        env: LITELLM_API_KEY",
        "      models:",
        "        local/test-model: {}",
        "  defaultProfileId: local-router",
        "  profiles:",
        "    - id: local-router",
        "      endpointId: local-router",
        "      model: local/test-model",
      ].join("\n"),
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_LLM_PROFILE;
    delete process.env.SLOPPY_MODEL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.llm.profiles[0]).toMatchObject({
      endpointId: "local-router",
      model: "local/test-model",
    });
    expect(config.llm.endpoints["local-router"]?.auth).toEqual({
      type: "env",
      env: "LITELLM_API_KEY",
    });
  });

  test("expands ~ in skills.skillsDir to the user's home directory", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_LLM_PROFILE;
    delete process.env.SLOPPY_MODEL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.plugins.skills.skillsDir).toBe(join(home, ".sloppy/skills"));
    expect(config.plugins.skills.builtinSkillsDir).toBe(join(process.cwd(), "skills"));
  });

  test("normalizes external skill directories", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(
      workspace,
      [
        "plugins:",
        "  skills:",
        "    externalDirs:",
        "      - ~/team-skills",
        "      - ./vendor-skills",
      ].join("\n"),
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_LLM_PROFILE;
    delete process.env.SLOPPY_MODEL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.plugins.skills.externalDirs).toEqual([
      join(home, "team-skills"),
      join(process.cwd(), "vendor-skills"),
    ]);
  });

  test("loads MCP server config and normalizes stdio cwd", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(
      workspace,
      [
        "plugins:",
        "  mcp:",
        "    enabled: true",
        "    connectOnStart: false",
        "    servers:",
        "      local:",
        "        name: Local MCP",
        "        transport: stdio",
        '        command: ["bunx", "demo-mcp"]',
        "        cwd: ./tools",
        "        envAllowlist: [DEMO_TOKEN]",
        "      hosted:",
        "        transport: streamableHttp",
        "        url: https://mcp.example.test/mcp",
        "        headers:",
        "          x-demo: demo",
      ].join("\n"),
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_LLM_PROFILE;
    delete process.env.SLOPPY_MODEL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.plugins.mcp.enabled).toBe(true);
    expect(config.plugins.mcp.connectOnStart).toBe(false);
    const local = config.plugins.mcp.servers.local;
    expect(local).toBeDefined();
    if (!local) {
      throw new Error("Expected local MCP server config.");
    }
    expect(local.transport).toBe("stdio");
    if (local.transport === "stdio") {
      expect(local.cwd).toBe(resolve(process.cwd(), "tools"));
      expect(local.envAllowlist).toEqual(["DEMO_TOKEN"]);
    }
    expect(config.plugins.mcp.servers.hosted.transport).toBe("streamableHttp");
  });

  test("loads A2A agent config", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(
      workspace,
      [
        "plugins:",
        "  a2a:",
        "    enabled: true",
        "    fetchOnStart: false",
        "    agents:",
        "      planner:",
        "        name: Planner",
        "        cardUrl: https://agent.example/.well-known/agent-card.json",
        "        bearerTokenEnv: A2A_TOKEN",
        "        timeoutMs: 15000",
        "      direct:",
        "        url: https://direct.example/a2a/rpc",
        "        protocolVersion: '1.0'",
        "        apiKeyEnv: DIRECT_A2A_KEY",
        "        apiKeyHeader: x-api-key",
      ].join("\n"),
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_LLM_PROFILE;
    delete process.env.SLOPPY_MODEL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.plugins.a2a.enabled).toBe(true);
    expect(config.plugins.a2a.fetchOnStart).toBe(false);
    expect(config.plugins.a2a.agents.planner.cardUrl).toBe(
      "https://agent.example/.well-known/agent-card.json",
    );
    expect(config.plugins.a2a.agents.planner.bearerTokenEnv).toBe("A2A_TOKEN");
    expect(config.plugins.a2a.agents.planner.timeoutMs).toBe(15000);
    expect(config.plugins.a2a.agents.direct.url).toBe("https://direct.example/a2a/rpc");
    expect(config.plugins.a2a.agents.direct.apiKeyHeader).toBe("x-api-key");
  });

  test("loads workspace/project registry and normalizes scoped config paths", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    await writeConfig(
      workspace,
      [
        "plugins:",
        "  workspaces:",
        "    enabled: true",
        "workspaces:",
        "  activeWorkspaceId: main",
        "  activeProjectId: app",
        "  items:",
        "    main:",
        "      name: Main Workspace",
        "      root: .",
        "      configPath: .sloppy/config.yaml",
        "      projects:",
        "        app:",
        "          name: App",
        "          root: apps/app",
        "          configPath: .sloppy/config.yaml",
      ].join("\n"),
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_LLM_PROFILE;
    delete process.env.SLOPPY_MODEL;
    process.chdir(workspace);

    const config = await loadConfig();
    const registry = config.workspaces;

    expect(config.plugins.workspaces.enabled).toBe(true);
    expect(registry?.activeWorkspaceId).toBe("main");
    expect(registry?.activeProjectId).toBe("app");
    const main = registry?.items.main;
    expect(main?.root).toBe(process.cwd());
    expect(main?.configPath).toBe(resolve(process.cwd(), ".sloppy/config.yaml"));
    expect(main?.projects.app.root).toBe(resolve(process.cwd(), "apps/app"));
    expect(main?.projects.app.configPath).toBe(
      resolve(process.cwd(), "apps/app/.sloppy/config.yaml"),
    );
  });

  test("loads scoped workspace/project config layers and pins provider roots to the project", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");
    const projectRoot = join(workspace, "apps/app");
    await mkdir(projectRoot, { recursive: true });
    await writeConfig(
      home,
      [
        "plugins:",
        "  workspaces:",
        "    enabled: true",
        "workspaces:",
        "  activeWorkspaceId: main",
        "  activeProjectId: app",
        "  items:",
        "    main:",
        "      name: Main Workspace",
        "      root: .",
        "      configPath: .sloppy/config.yaml",
        "      projects:",
        "        app:",
        "          name: App",
        "          root: apps/app",
        "          configPath: .sloppy/config.yaml",
      ].join("\n"),
    );
    await writeConfig(
      workspace,
      [
        "llm:",
        "  defaultProfileId: scoped-openai",
        "  profiles:",
        "    - id: scoped-openai",
        "      endpointId: openai",
        "      model: workspace-model",
        "plugins:",
        "  mcp:",
        "    connectOnStart: false",
      ].join("\n"),
    );
    await writeConfig(
      projectRoot,
      [
        "llm:",
        "  profiles:",
        "    - id: scoped-openai",
        "      endpointId: openai",
        "      model: project-model",
        "plugins:",
        "  mcp:",
        "    enabled: true",
        "    servers:",
        "      project-tools:",
        "        transport: stdio",
        '        command: ["project-mcp"]',
        "        cwd: ./tools",
      ].join("\n"),
    );

    process.env.HOME = home;
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_LLM_PROFILE;
    delete process.env.SLOPPY_MODEL;
    process.chdir(workspace);

    const config = await loadScopedConfig({
      homeConfigPath: join(home, ".sloppy/config.yaml"),
      workspaceConfigPath: join(workspace, ".sloppy/config.yaml"),
      cwd: workspace,
      workspaceId: "main",
      projectId: "app",
    });

    expect(config.llm.profiles[0]?.model).toBe("project-model");
    expect(config.workspaces?.activeWorkspaceId).toBe("main");
    expect(config.workspaces?.activeProjectId).toBe("app");
    expect(config.plugins.filesystem.root).toBe(projectRoot);
    expect(config.plugins.filesystem.focus).toBe(projectRoot);
    expect(config.plugins.terminal.cwd).toBe(projectRoot);
    expect(config.plugins.mcp.enabled).toBe(true);
    const mcp = config.plugins.mcp.servers["project-tools"];
    expect(mcp?.transport).toBe("stdio");
    if (mcp?.transport === "stdio") {
      expect(mcp.cwd).toBe(join(projectRoot, "tools"));
    }
  });

  test("applies env override for max iterations", async () => {
    const home = await createTempDir("sloppy-home-");
    const workspace = await createTempDir("sloppy-workspace-");

    process.env.HOME = home;
    process.env.SLOPPY_MAX_ITERATIONS = "80";
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_LLM_PROFILE;
    delete process.env.SLOPPY_MODEL;
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
        "plugins:",
        "  delegation:",
        "    enabled: true",
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
    delete process.env.SLOPPY_LLM_ENDPOINT;
    delete process.env.SLOPPY_LLM_PROFILE;
    delete process.env.SLOPPY_MODEL;
    process.chdir(workspace);

    const config = await loadConfig();

    expect(config.plugins.delegation.acp?.adapters.fake.capabilities).toEqual({
      spawn_allowed: false,
      shell_allowed: true,
      network_allowed: false,
      filesystem_reads_allowed: true,
      filesystem_writes_allowed: false,
    });
    expect(config.plugins.delegation.acp?.adapters.fake.inheritEnv ?? false).toBe(false);
  });
});
