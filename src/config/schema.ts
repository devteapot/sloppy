import { z } from "zod";

export const sloppyConfigSchema = z.object({
  llm: z
    .object({
      provider: z.literal("anthropic").default("anthropic"),
      model: z.string().default("claude-sonnet-4-20250514"),
      apiKeyEnv: z.string().default("ANTHROPIC_API_KEY"),
      maxTokens: z.number().int().min(256).default(4096),
    })
    .default({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      maxTokens: 4096,
    }),
  agent: z
    .object({
      maxIterations: z.number().int().min(1).default(12),
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
      maxIterations: 12,
      contextBudgetTokens: 24000,
      minSalience: 0.2,
      overviewDepth: 2,
      overviewMaxNodes: 200,
      detailDepth: 4,
      detailMaxNodes: 200,
      historyTurns: 8,
      toolResultMaxChars: 16000,
    }),
  providers: z
    .object({
      builtin: z
        .object({
          terminal: z.boolean().default(true),
          filesystem: z.boolean().default(true),
        })
        .default({
          terminal: true,
          filesystem: true,
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
        })
        .default({
          root: ".",
          recentLimit: 10,
          searchLimit: 20,
          readMaxBytes: 65536,
        }),
    })
    .default({
      builtin: {
        terminal: true,
        filesystem: true,
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
      },
    }),
});

export type SloppyConfig = z.infer<typeof sloppyConfigSchema>;
