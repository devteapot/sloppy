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
      }),
    )
    .default({}),
});

const gateResolverSchema = z.enum(["user", "policy"]);
const gatePolicyGateSchema = z
  .object({
    goalAccept: gateResolverSchema.optional(),
    specAccept: gateResolverSchema.optional(),
    planAccept: gateResolverSchema.optional(),
    sliceGate: gateResolverSchema.optional(),
    irreversibleAction: gateResolverSchema.optional(),
    budgetExceeded: gateResolverSchema.optional(),
    driftEscalation: gateResolverSchema.optional(),
  })
  .default({});
const gatePolicyScopeSchema = z.object({
  defaultResolver: gateResolverSchema.optional(),
  gates: gatePolicyGateSchema,
});
const gatePolicySchema = gatePolicyScopeSchema.extend({
  goals: z.record(z.string().min(1), gatePolicyScopeSchema).default({}),
  specs: z.record(z.string().min(1), gatePolicyScopeSchema).default({}),
  slices: z.record(z.string().min(1), gatePolicyScopeSchema).default({}),
});

const digestCadenceSchema = z.enum([
  "manual",
  "on_milestone",
  "on_escalation",
  "daily",
  "continuous",
  "final",
]);

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
          web: z.boolean().default(false),
          browser: z.boolean().default(false),
          cron: z.boolean().default(false),
          messaging: z.boolean().default(false),
          delegation: z.boolean().default(false),
          orchestration: z.boolean().default(false),
          spec: z.boolean().default(false),
          vision: z.boolean().default(false),
        })
        .default({
          terminal: true,
          filesystem: true,
          memory: true,
          skills: true,
          web: false,
          browser: false,
          cron: false,
          messaging: false,
          delegation: false,
          orchestration: false,
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
      orchestration: z
        .object({
          progressTailMaxChars: z.number().int().min(128).default(2048),
          finalAuditCommandTimeoutMs: z.number().int().min(100).default(30000),
          budget: z
            .object({
              wallTimeMs: z.number().int().min(1).optional(),
              retriesPerSlice: z.number().int().min(0).optional(),
              tokenLimit: z.number().int().min(1).optional(),
              costUsd: z.number().min(0).optional(),
            })
            .default({}),
          policy: gatePolicySchema.default({
            gates: {},
            goals: {},
            specs: {},
            slices: {},
          }),
          guardrails: z
            .object({
              repeatedFailureLimit: z.number().int().min(1).optional(),
              progressStallLimit: z.number().int().min(1).optional(),
              progressProjectionRequiresBudget: z.boolean().optional(),
              coherenceReplanRateLimit: z.number().int().min(1).optional(),
              coherenceQuestionDensityLimit: z.number().int().min(1).optional(),
              blastRadius: z
                .object({
                  maxFilesModified: z.number().int().min(0).optional(),
                  maxDepsAdded: z.number().int().min(0).optional(),
                  maxExternalCalls: z.number().int().min(0).optional(),
                  publicSurfaceDeltaRequiresGate: z.boolean().optional(),
                })
                .default({}),
            })
            .default({
              blastRadius: {},
            }),
          digest: z
            .object({
              cadence: digestCadenceSchema.default("manual"),
            })
            .default({
              cadence: "manual",
            }),
          delivery: z
            .object({
              channel: z.string().min(1).optional(),
              slack: z
                .object({
                  webhookUrl: z.string().url().optional(),
                  webhookUrlEnv: z.string().min(1).optional(),
                  username: z.string().min(1).optional(),
                  iconEmoji: z.string().min(1).optional(),
                })
                .default({}),
              email: z
                .object({
                  endpointUrl: z.string().url().optional(),
                  endpointUrlEnv: z.string().min(1).optional(),
                  apiKeyEnv: z.string().min(1).optional(),
                  from: z.string().min(1).optional(),
                  to: z.array(z.string().min(1)).default([]),
                  subjectPrefix: z.string().min(1).optional(),
                  headers: z.record(z.string(), z.string()).default({}),
                })
                .default({
                  to: [],
                  headers: {},
                }),
            })
            .default({
              slack: {},
              email: { to: [], headers: {} },
            }),
        })
        .default({
          progressTailMaxChars: 2048,
          finalAuditCommandTimeoutMs: 30000,
          budget: {},
          policy: {
            gates: {},
            goals: {},
            specs: {},
            slices: {},
          },
          guardrails: {
            blastRadius: {},
          },
          digest: {
            cadence: "manual",
          },
          delivery: {
            slack: {},
            email: {
              to: [],
              headers: {},
            },
          },
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
        web: false,
        browser: false,
        cron: false,
        messaging: false,
        delegation: false,
        orchestration: false,
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
      orchestration: {
        progressTailMaxChars: 2048,
        finalAuditCommandTimeoutMs: 30000,
        budget: {},
        policy: {
          gates: {},
          goals: {},
          specs: {},
          slices: {},
        },
        guardrails: {
          blastRadius: {},
        },
        digest: {
          cadence: "manual",
        },
        delivery: {
          slack: {},
          email: {
            to: [],
            headers: {},
          },
        },
      },
      vision: {
        maxImages: 50,
        defaultWidth: 512,
        defaultHeight: 512,
      },
    }),
});

type SloppyConfigBase = z.infer<typeof sloppyConfigSchema>;
type ProviderConfigBase = SloppyConfigBase["providers"];

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

export interface SloppyConfig extends Omit<SloppyConfigBase, "llm" | "providers"> {
  llm: LlmConfig;
  providers: Omit<ProviderConfigBase, "orchestration"> & {
    orchestration: Omit<
      ProviderConfigBase["orchestration"],
      "budget" | "policy" | "guardrails" | "digest" | "delivery"
    > & {
      budget?: ProviderConfigBase["orchestration"]["budget"];
      policy?: ProviderConfigBase["orchestration"]["policy"];
      guardrails?: ProviderConfigBase["orchestration"]["guardrails"];
      digest?: ProviderConfigBase["orchestration"]["digest"];
      delivery?: ProviderConfigBase["orchestration"]["delivery"];
    };
  };
}

export type RawSloppyConfig = SloppyConfigBase;
