import { z } from "zod";

export const llmProviderSchema = z.enum([
  "anthropic",
  "openai",
  "openai-codex",
  "openrouter",
  "ollama",
  "gemini",
  "acp",
]);

export const llmReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export const llmProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1).optional(),
  provider: llmProviderSchema,
  model: z.string().optional(),
  reasoningEffort: llmReasoningEffortSchema.optional(),
  adapterId: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  baseUrl: z.string().optional(),
  contextWindowTokens: z.number().int().min(1).optional(),
});

const acpDelegationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  defaultTimeoutMs: z.number().int().min(1000).optional(),
  adapters: z
    .record(
      z.string().min(1),
      z.object({
        command: z.array(z.string().min(1)).min(1),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        envAllowlist: z.array(z.string().min(1)).optional(),
        inheritEnv: z.boolean().optional(),
        allowCwdOutsideWorkspace: z.boolean().optional(),
        timeoutMs: z.number().int().min(1000).optional(),
        capabilities: z
          .object({
            spawn_allowed: z.boolean().default(false),
            shell_allowed: z.boolean().default(false),
            network_allowed: z.boolean().default(false),
            filesystem_reads_allowed: z.boolean().default(true),
            filesystem_writes_allowed: z.boolean().default(false),
          })
          .optional(),
      }),
    )
    .default({}),
});

const mcpStdioServerConfigSchema = z.object({
  name: z.string().trim().min(1).optional(),
  transport: z.literal("stdio"),
  command: z.array(z.string().min(1)).min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  envAllowlist: z.array(z.string().min(1)).optional(),
  inheritEnv: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  connectOnStart: z.boolean().optional(),
});

const mcpStreamableHttpServerConfigSchema = z.object({
  name: z.string().trim().min(1).optional(),
  transport: z.literal("streamableHttp"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  connectOnStart: z.boolean().optional(),
});

const mcpServerConfigSchema = z.discriminatedUnion("transport", [
  mcpStdioServerConfigSchema,
  mcpStreamableHttpServerConfigSchema,
]);

const a2aAgentConfigSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    cardUrl: z.string().url().optional(),
    url: z.string().url().optional(),
    protocolVersion: z.string().trim().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    bearerTokenEnv: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
    apiKeyHeader: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(1000).optional(),
    fetchOnStart: z.boolean().optional(),
  })
  .refine((config) => Boolean(config.cardUrl || config.url), {
    message: "A2A agents require cardUrl or url.",
  });

const persistentGoalPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .default({
    enabled: false,
  });

const terminalPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    cwd: z.string().default("."),
    historyLimit: z.number().int().min(1).default(10),
    syncTimeoutMs: z.number().int().min(100).default(30000),
  })
  .default({
    enabled: true,
    cwd: ".",
    historyLimit: 10,
    syncTimeoutMs: 30000,
  });

const filesystemPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    root: z.string().default("."),
    focus: z.string().optional(),
    recentLimit: z.number().int().min(1).default(10),
    searchLimit: z.number().int().min(1).default(20),
    readMaxBytes: z.number().int().min(256).default(65536),
    contentRefThresholdBytes: z.number().int().min(256).default(8192),
    previewBytes: z.number().int().min(128).default(2048),
  })
  .default({
    enabled: true,
    root: ".",
    recentLimit: 10,
    searchLimit: 20,
    readMaxBytes: 65536,
    contentRefThresholdBytes: 8192,
    previewBytes: 2048,
  });

const memoryPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxMemories: z.number().int().min(1).default(500),
    defaultWeight: z.number().min(0).max(1).default(0.5),
    compactThreshold: z.number().min(0).max(1).default(0.2),
  })
  .default({
    enabled: false,
    maxMemories: 500,
    defaultWeight: 0.5,
    compactThreshold: 0.2,
  });

const skillsPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    builtinSkillsDir: z.string().default("skills"),
    skillsDir: z.string().default("~/.sloppy/skills"),
    externalDirs: z.array(z.string()).default([]),
    templateVars: z.boolean().default(true),
    viewMaxBytes: z.number().int().min(1024).default(65536),
  })
  .default({
    enabled: false,
    builtinSkillsDir: "skills",
    skillsDir: "~/.sloppy/skills",
    externalDirs: [],
    templateVars: true,
    viewMaxBytes: 65536,
  });

const metaRuntimePluginConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    globalRoot: z.string().default("~/.sloppy/meta-runtime"),
    workspaceRoot: z.string().default(".sloppy/meta-runtime"),
  })
  .default({
    enabled: false,
    globalRoot: "~/.sloppy/meta-runtime",
    workspaceRoot: ".sloppy/meta-runtime",
  });

const webPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    historyLimit: z.number().int().min(1).default(20),
  })
  .default({
    enabled: false,
    historyLimit: 20,
  });

const browserPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    viewportWidth: z.number().int().min(320).default(1280),
    viewportHeight: z.number().int().min(240).default(720),
  })
  .default({
    enabled: false,
    viewportWidth: 1280,
    viewportHeight: 720,
  });

const cronPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxJobs: z.number().int().min(1).default(50),
  })
  .default({
    enabled: false,
    maxJobs: 50,
  });

const messagingPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxMessages: z.number().int().min(1).default(500),
  })
  .default({
    enabled: false,
    maxMessages: 500,
  });

const delegationPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxAgents: z.number().int().min(1).default(10),
    acp: acpDelegationConfigSchema.optional(),
  })
  .default({
    enabled: false,
    maxAgents: 10,
  });

const specPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .default({
    enabled: false,
  });

const visionPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxImages: z.number().int().min(1).default(50),
    defaultWidth: z.number().int().min(64).default(512),
    defaultHeight: z.number().int().min(64).default(512),
  })
  .default({
    enabled: false,
    maxImages: 50,
    defaultWidth: 512,
    defaultHeight: 512,
  });

const mcpPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    connectOnStart: z.boolean().default(true),
    servers: z.record(z.string().min(1), mcpServerConfigSchema).default({}),
  })
  .default({
    enabled: false,
    connectOnStart: true,
    servers: {},
  });

const workspacesPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .default({
    enabled: false,
  });

const a2aPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    fetchOnStart: z.boolean().default(true),
    agents: z.record(z.string().min(1), a2aAgentConfigSchema).default({}),
  })
  .default({
    enabled: false,
    fetchOnStart: true,
    agents: {},
  });

const pluginsConfigSchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    "persistent-goal": persistentGoalPluginConfigSchema,
    terminal: terminalPluginConfigSchema,
    filesystem: filesystemPluginConfigSchema,
    memory: memoryPluginConfigSchema,
    skills: skillsPluginConfigSchema,
    "meta-runtime": metaRuntimePluginConfigSchema,
    web: webPluginConfigSchema,
    browser: browserPluginConfigSchema,
    cron: cronPluginConfigSchema,
    messaging: messagingPluginConfigSchema,
    delegation: delegationPluginConfigSchema,
    spec: specPluginConfigSchema,
    vision: visionPluginConfigSchema,
    mcp: mcpPluginConfigSchema,
    workspaces: workspacesPluginConfigSchema,
    a2a: a2aPluginConfigSchema,
  }),
);

const projectConfigSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  root: z.string().default("."),
  configPath: z.string().default(".sloppy/config.yaml"),
  tags: z.array(z.string().min(1)).default([]),
});

const workspaceConfigSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  root: z.string(),
  configPath: z.string().default(".sloppy/config.yaml"),
  tags: z.array(z.string().min(1)).default([]),
  projects: z.record(z.string().min(1), projectConfigSchema).default({}),
});

export const sloppyConfigSchema = z.object({
  workspaces: z
    .object({
      activeWorkspaceId: z.string().min(1).optional(),
      activeProjectId: z.string().min(1).optional(),
      items: z.record(z.string().min(1), workspaceConfigSchema).default({}),
    })
    .default({
      items: {},
    }),
  llm: z
    .object({
      provider: llmProviderSchema.default("anthropic"),
      model: z.string().optional(),
      reasoningEffort: llmReasoningEffortSchema.optional(),
      adapterId: z.string().optional(),
      apiKeyEnv: z.string().optional(),
      baseUrl: z.string().optional(),
      contextWindowTokens: z.number().int().min(1).optional(),
      defaultProfileId: z.string().optional(),
      profiles: z.array(llmProfileSchema).default([]),
      maxTokens: z.number().int().min(256).default(4096),
    })
    .default({
      provider: "anthropic",
      profiles: [],
      maxTokens: 4096,
    }),
  agent: z
    .object({
      maxIterations: z.number().int().min(1).default(32),
      minSalience: z.number().min(0).max(1).default(0.2),
      overviewDepth: z.number().int().min(1).default(2),
      overviewMaxNodes: z.number().int().min(10).default(200),
      detailDepth: z.number().int().min(1).default(4),
      detailMaxNodes: z.number().int().min(10).default(200),
      historyTurns: z.number().int().min(1).default(8),
      toolResultMaxChars: z.number().int().min(512).default(16000),
    })
    .default({
      maxIterations: 32,
      minSalience: 0.2,
      overviewDepth: 2,
      overviewMaxNodes: 200,
      detailDepth: 4,
      detailMaxNodes: 200,
      historyTurns: 8,
      toolResultMaxChars: 16000,
    }),
  session: z
    .object({
      persistSnapshots: z.boolean().default(true),
      persistenceDir: z.string().default(".sloppy/sessions"),
    })
    .default({
      persistSnapshots: true,
      persistenceDir: ".sloppy/sessions",
    }),
  plugins: pluginsConfigSchema,
  maxToolResultSize: z.number().int().min(100).default(4096),
  providers: z
    .object({
      discovery: z
        .object({
          enabled: z.boolean().default(true),
          paths: z.array(z.string()).default(["~/.slop/providers", "/tmp/slop/providers"]),
        })
        .default({
          enabled: true,
          paths: ["~/.slop/providers", "/tmp/slop/providers"],
        }),
    })
    .strict()
    .default({
      discovery: {
        enabled: true,
        paths: ["~/.slop/providers", "/tmp/slop/providers"],
      },
    }),
});

type SloppyConfigBase = z.infer<typeof sloppyConfigSchema>;
type PluginsConfig = SloppyConfigBase["plugins"];
type WorkspaceRegistryConfig = SloppyConfigBase["workspaces"];

export type LlmProvider = z.infer<typeof llmProviderSchema>;
export type LlmReasoningEffort = z.infer<typeof llmReasoningEffortSchema>;

export type LlmProfileConfig = {
  id: string;
  label?: string;
  provider: LlmProvider;
  model: string;
  reasoningEffort?: LlmReasoningEffort;
  adapterId?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  contextWindowTokens?: number;
};

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  reasoningEffort?: LlmReasoningEffort;
  adapterId?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  contextWindowTokens?: number;
  defaultProfileId?: string;
  profiles: LlmProfileConfig[];
  maxTokens: number;
}

export interface SloppyConfig
  extends Omit<SloppyConfigBase, "llm" | "plugins" | "session" | "workspaces"> {
  llm: LlmConfig;
  plugins: PluginsConfig;
  session?: {
    persistSnapshots?: boolean;
    persistenceDir?: string;
  };
  workspaces?: WorkspaceRegistryConfig;
}

export type RawSloppyConfig = SloppyConfigBase;
