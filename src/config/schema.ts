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
      contextBudgetTokens: z.number().int().min(1024).default(24000),
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
      contextBudgetTokens: 24000,
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
  maxToolResultSize: z.number().int().min(100).default(4096),
  providers: z
    .object({
      builtin: z
        .object({
          terminal: z.boolean().default(true),
          filesystem: z.boolean().default(true),
          memory: z.boolean().default(true),
          skills: z.boolean().default(true),
          metaRuntime: z.boolean().default(false),
          web: z.boolean().default(false),
          browser: z.boolean().default(false),
          cron: z.boolean().default(false),
          messaging: z.boolean().default(false),
          delegation: z.boolean().default(false),
          spec: z.boolean().default(false),
          vision: z.boolean().default(false),
          mcp: z.boolean().default(false),
          workspaces: z.boolean().default(false),
          a2a: z.boolean().default(false),
        })
        .default({
          terminal: true,
          filesystem: true,
          memory: true,
          skills: true,
          metaRuntime: false,
          web: false,
          browser: false,
          cron: false,
          messaging: false,
          delegation: false,
          spec: false,
          vision: false,
          mcp: false,
          workspaces: false,
          a2a: false,
        }),
      discovery: z
        .object({
          enabled: z.boolean().default(true),
          paths: z.array(z.string()).default(["~/.slop/providers", "/tmp/slop/providers"]),
        })
        .default({
          enabled: true,
          paths: ["~/.slop/providers", "/tmp/slop/providers"],
        }),
      terminal: z
        .object({
          cwd: z.string().default("."),
          historyLimit: z.number().int().min(1).default(10),
          syncTimeoutMs: z.number().int().min(100).default(30000),
        })
        .default({
          cwd: ".",
          historyLimit: 10,
          syncTimeoutMs: 30000,
        }),
      filesystem: z
        .object({
          root: z.string().default("."),
          focus: z.string().optional(),
          recentLimit: z.number().int().min(1).default(10),
          searchLimit: z.number().int().min(1).default(20),
          readMaxBytes: z.number().int().min(256).default(65536),
          contentRefThresholdBytes: z.number().int().min(256).default(8192),
          previewBytes: z.number().int().min(128).default(2048),
        })
        .default({
          root: ".",
          recentLimit: 10,
          searchLimit: 20,
          readMaxBytes: 65536,
          contentRefThresholdBytes: 8192,
          previewBytes: 2048,
        }),
      memory: z
        .object({
          maxMemories: z.number().int().min(1).default(500),
          defaultWeight: z.number().min(0).max(1).default(0.5),
          compactThreshold: z.number().min(0).max(1).default(0.2),
        })
        .default({
          maxMemories: 500,
          defaultWeight: 0.5,
          compactThreshold: 0.2,
        }),
      skills: z
        .object({
          builtinSkillsDir: z.string().default("skills"),
          skillsDir: z.string().default("~/.sloppy/skills"),
          externalDirs: z.array(z.string()).default([]),
          templateVars: z.boolean().default(true),
          viewMaxBytes: z.number().int().min(1024).default(65536),
        })
        .default({
          builtinSkillsDir: "skills",
          skillsDir: "~/.sloppy/skills",
          externalDirs: [],
          templateVars: true,
          viewMaxBytes: 65536,
        }),
      metaRuntime: z
        .object({
          globalRoot: z.string().default("~/.sloppy/meta-runtime"),
          workspaceRoot: z.string().default(".sloppy/meta-runtime"),
        })
        .default({
          globalRoot: "~/.sloppy/meta-runtime",
          workspaceRoot: ".sloppy/meta-runtime",
        }),
      web: z
        .object({
          historyLimit: z.number().int().min(1).default(20),
        })
        .default({
          historyLimit: 20,
        }),
      browser: z
        .object({
          viewportWidth: z.number().int().min(320).default(1280),
          viewportHeight: z.number().int().min(240).default(720),
        })
        .default({
          viewportWidth: 1280,
          viewportHeight: 720,
        }),
      cron: z
        .object({
          maxJobs: z.number().int().min(1).default(50),
        })
        .default({
          maxJobs: 50,
        }),
      messaging: z
        .object({
          maxMessages: z.number().int().min(1).default(500),
        })
        .default({
          maxMessages: 500,
        }),
      delegation: z
        .object({
          maxAgents: z.number().int().min(1).default(10),
          acp: acpDelegationConfigSchema.optional(),
        })
        .default({
          maxAgents: 10,
        }),
      vision: z
        .object({
          maxImages: z.number().int().min(1).default(50),
          defaultWidth: z.number().int().min(64).default(512),
          defaultHeight: z.number().int().min(64).default(512),
        })
        .default({
          maxImages: 50,
          defaultWidth: 512,
          defaultHeight: 512,
        }),
      mcp: z
        .object({
          connectOnStart: z.boolean().default(true),
          servers: z.record(z.string().min(1), mcpServerConfigSchema).default({}),
        })
        .default({
          connectOnStart: true,
          servers: {},
        }),
      a2a: z
        .object({
          fetchOnStart: z.boolean().default(true),
          agents: z.record(z.string().min(1), a2aAgentConfigSchema).default({}),
        })
        .default({
          fetchOnStart: true,
          agents: {},
        }),
    })
    .default({
      builtin: {
        terminal: true,
        filesystem: true,
        memory: true,
        skills: true,
        metaRuntime: false,
        web: false,
        browser: false,
        cron: false,
        messaging: false,
        delegation: false,
        spec: false,
        vision: false,
        mcp: false,
        workspaces: false,
        a2a: false,
      },
      discovery: {
        enabled: true,
        paths: ["~/.slop/providers", "/tmp/slop/providers"],
      },
      terminal: {
        cwd: ".",
        historyLimit: 10,
        syncTimeoutMs: 30000,
      },
      filesystem: {
        root: ".",
        recentLimit: 10,
        searchLimit: 20,
        readMaxBytes: 65536,
        contentRefThresholdBytes: 8192,
        previewBytes: 2048,
      },
      memory: {
        maxMemories: 500,
        defaultWeight: 0.5,
        compactThreshold: 0.2,
      },
      skills: {
        builtinSkillsDir: "skills",
        skillsDir: "~/.sloppy/skills",
        externalDirs: [],
        templateVars: true,
        viewMaxBytes: 65536,
      },
      metaRuntime: {
        globalRoot: "~/.sloppy/meta-runtime",
        workspaceRoot: ".sloppy/meta-runtime",
      },
      web: {
        historyLimit: 20,
      },
      browser: {
        viewportWidth: 1280,
        viewportHeight: 720,
      },
      cron: {
        maxJobs: 50,
      },
      messaging: {
        maxMessages: 500,
      },
      delegation: {
        maxAgents: 10,
      },
      vision: {
        maxImages: 50,
        defaultWidth: 512,
        defaultHeight: 512,
      },
      mcp: {
        connectOnStart: true,
        servers: {},
      },
      a2a: {
        fetchOnStart: true,
        agents: {},
      },
    }),
});

type SloppyConfigBase = z.infer<typeof sloppyConfigSchema>;
type BuiltinProviderConfig = Omit<
  SloppyConfigBase["providers"]["builtin"],
  "mcp" | "workspaces" | "a2a"
> & {
  mcp?: boolean;
  workspaces?: boolean;
  a2a?: boolean;
};
type McpProviderConfig = SloppyConfigBase["providers"]["mcp"];
type A2AProviderConfig = SloppyConfigBase["providers"]["a2a"];
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
};

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  reasoningEffort?: LlmReasoningEffort;
  adapterId?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  defaultProfileId?: string;
  profiles: LlmProfileConfig[];
  maxTokens: number;
}

export interface SloppyConfig
  extends Omit<SloppyConfigBase, "llm" | "providers" | "session" | "workspaces"> {
  llm: LlmConfig;
  session?: {
    persistSnapshots?: boolean;
    persistenceDir?: string;
  };
  workspaces?: WorkspaceRegistryConfig;
  providers: Omit<SloppyConfigBase["providers"], "builtin" | "skills" | "mcp" | "a2a"> & {
    builtin: BuiltinProviderConfig;
    mcp?: McpProviderConfig;
    a2a?: A2AProviderConfig;
    skills: {
      skillsDir: string;
      builtinSkillsDir?: string;
      externalDirs?: string[];
      templateVars?: boolean;
      viewMaxBytes?: number;
    };
  };
}

export type RawSloppyConfig = SloppyConfigBase;
