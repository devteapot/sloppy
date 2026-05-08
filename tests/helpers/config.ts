import { type LlmConfig, type SloppyConfig, sloppyConfigSchema } from "../../src/config/schema";

export type TestPluginOverrides = {
  [Key in keyof SloppyConfig["plugins"]]?: Partial<SloppyConfig["plugins"][Key]>;
};

export function testPlugins(overrides: TestPluginOverrides = {}): SloppyConfig["plugins"] {
  return sloppyConfigSchema.parse({ plugins: overrides }).plugins;
}

export function createTestConfig(
  overrides: {
    llm?: Partial<LlmConfig>;
    agent?: Partial<SloppyConfig["agent"]>;
    plugins?: TestPluginOverrides;
    discovery?: Partial<SloppyConfig["providers"]["discovery"]>;
    maxToolResultSize?: number;
  } = {},
): SloppyConfig {
  return {
    llm: {
      provider: "openai",
      model: "gpt-5.4",
      profiles: [],
      maxTokens: 4096,
      ...overrides.llm,
    },
    agent: {
      maxIterations: 12,
      minSalience: 0.2,
      overviewDepth: 2,
      overviewMaxNodes: 200,
      detailDepth: 4,
      detailMaxNodes: 200,
      historyTurns: 8,
      toolResultMaxChars: 16000,
      ...overrides.agent,
    },
    plugins: testPlugins(overrides.plugins),
    maxToolResultSize: overrides.maxToolResultSize ?? 4096,
    providers: {
      discovery: {
        enabled: false,
        paths: [],
        ...overrides.discovery,
      },
    },
  };
}
