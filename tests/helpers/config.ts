import { type LlmConfig, type SloppyConfig, sloppyConfigSchema } from "../../src/config/schema";
import { mergeLlmEndpoints } from "../../src/llm/catalog";

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
  const llmOverrides = overrides.llm ?? {};
  return {
    llm: {
      defaultProfileId: "openai-main",
      profiles: [
        {
          kind: "native",
          id: "openai-main",
          endpointId: "openai",
          model: "gpt-5.4",
        },
      ],
      maxTokens: 4096,
      ...llmOverrides,
      endpoints: mergeLlmEndpoints(llmOverrides.endpoints ?? {}),
    },
    agent: {
      maxIterations: 12,
      overviewDepth: 2,
      detailDepth: 4,
      historyTurns: 8,
      toolResultMaxChars: 16000,
      contextCompaction: {
        enabled: true,
        reserveTokens: 8192,
        keepRecentTokens: 20000,
        summaryMaxTokens: 2048,
        retryOnOverflow: true,
      },
      toolResultImageMaxBytes: 5_242_880,
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
