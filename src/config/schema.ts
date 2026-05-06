import { z } from "zod";

export const llmProviderSchema = z.enum(["anthropic", "openai", "openrouter", "ollama", "gemini"]);

export const llmProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1).optional(),
  provider: llmProviderSchema,
  model: z.string().optional(),
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

const cliDelegationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  defaultTimeoutMs: z.number().int().min(1000).optional(),
  adapters: z
    .record(
      z.string().min(1),
      z.object({
        command: z.array(z.string().min(1)).min(1),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        timeoutMs: z.number().int().min(1000).optional(),
        appendPrompt: z.boolean().optional(),
      }),
    )
    .default({}),
});

export const sloppyConfigSchema = z.object({
  llm: z
    .object({
      provider: llmProviderSchema.default("anthropic"),
      model: z.string().optional(),
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
          skillsDir: z.string().default("~/.hermes/skills"),
        })
        .default({
          skillsDir: "~/.hermes/skills",
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
          cli: cliDelegationConfigSchema.optional(),
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
        skillsDir: "~/.hermes/skills",
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
    }),
});

type SloppyConfigBase = z.infer<typeof sloppyConfigSchema>;

export type LlmProvider = z.infer<typeof llmProviderSchema>;

export type LlmProfileConfig = {
  id: string;
  label?: string;
  provider: LlmProvider;
  model: string;
  apiKeyEnv?: string;
  baseUrl?: string;
};

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  defaultProfileId?: string;
  profiles: LlmProfileConfig[];
  maxTokens: number;
}

export interface SloppyConfig extends Omit<SloppyConfigBase, "llm"> {
  llm: LlmConfig;
}

export type RawSloppyConfig = SloppyConfigBase;
