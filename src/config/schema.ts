import { z } from "zod";

export const llmProtocolSchema = z.enum([
  "anthropic-messages",
  "openai-chat",
  "openai-responses",
  "openai-codex",
  "gemini",
]);

export const llmReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const llmThinkingDisplaySchema = z.enum(["visible", "hidden"]);

export const DEFAULT_LLM_REQUEST_POLICY = {
  timeoutMs: 120_000,
  maxRetries: 2,
  baseRetryDelayMs: 500,
  maxRetryDelayMs: 10_000,
} as const;

export const MAX_LLM_REQUEST_TIMER_MS = 2_147_483_647;

const providerOptionsSchema = z.record(z.string(), z.unknown()).default({});

const SENSITIVE_LLM_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
  "anthropic-api-key",
  "x-goog-api-key",
]);

export function isSensitiveLlmHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    SENSITIVE_LLM_HEADER_NAMES.has(normalized) ||
    /(^|[-_])(auth|authorization|cookie|credential|credentials|key|password|passwd|secret)([-_]|$)/.test(
      normalized,
    ) ||
    /(^|[-_])(api|access|auth|client|secret)[-_]?key($|[-_])/.test(normalized) ||
    normalized.endsWith("-token") ||
    normalized.endsWith("_token")
  );
}

const llmLiteralHeadersSchema = z
  .record(z.string().trim().min(1), z.string())
  .superRefine((headers, context) => {
    for (const name of Object.keys(headers)) {
      if (!isSensitiveLlmHeaderName(name)) continue;
      context.addIssue({
        code: "custom",
        path: [name],
        message: `Sensitive LLM header '${name}' must use headerEnv instead of a literal value.`,
      });
    }
  });

const llmHeaderEnvSchema = z.record(
  z.string().trim().min(1),
  z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Expected an environment variable name."),
);

const llmBaseUrlSchema = z
  .string()
  .trim()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "LLM endpoint baseUrl must use http or https.",
      });
    }
    if (url.username || url.password) {
      context.addIssue({
        code: "custom",
        message: "LLM endpoint baseUrl must not contain embedded credentials.",
      });
    }
    if (url.hash) {
      context.addIssue({
        code: "custom",
        message: "LLM endpoint baseUrl must not contain a URL fragment.",
      });
    }
    if (url.search) {
      context.addIssue({
        code: "custom",
        message: "LLM endpoint baseUrl must not contain query parameters.",
      });
    }
  });

const openAiThinkingSchema = z
  .object({
    effort: llmReasoningEffortSchema.optional(),
    summary: z.enum(["auto", "concise", "detailed", "none"]).optional(),
    options: providerOptionsSchema.optional(),
  })
  .strict();

const anthropicThinkingSchema = z
  .object({
    type: z.enum(["adaptive", "enabled", "disabled"]).optional(),
    effort: llmReasoningEffortSchema.optional(),
    budgetTokens: z.number().int().min(1024).optional(),
    output: z.enum(["summarized", "omitted"]).optional(),
    options: providerOptionsSchema.optional(),
  })
  .strict();

const geminiThinkingSchema = z
  .object({
    includeThoughts: z.boolean().optional(),
    thinkingBudget: z.number().int().optional(),
    thinkingLevel: z.enum(["low", "medium", "high"]).optional(),
    options: providerOptionsSchema.optional(),
  })
  .strict();

const openRouterThinkingSchema = z
  .object({
    effort: llmReasoningEffortSchema.optional(),
    exclude: z.boolean().optional(),
    options: providerOptionsSchema.optional(),
  })
  .strict();

const ollamaThinkingSchema = z
  .object({
    think: z.union([z.boolean(), z.enum(["low", "medium", "high"])]).optional(),
    options: providerOptionsSchema.optional(),
  })
  .strict();

export const llmThinkingConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    display: llmThinkingDisplaySchema.optional(),
    effort: llmReasoningEffortSchema.optional(),
    openai: openAiThinkingSchema.optional(),
    openaiCodex: openAiThinkingSchema.optional(),
    anthropic: anthropicThinkingSchema.optional(),
    gemini: geminiThinkingSchema.optional(),
    openrouter: openRouterThinkingSchema.optional(),
    ollama: ollamaThinkingSchema.optional(),
  })
  .strict();

export const llmEndpointAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("env"), env: z.string().trim().min(1) }).strict(),
  z.object({ type: z.literal("secure_store") }).strict(),
  z.object({ type: z.literal("codex") }).strict(),
]);

export const llmEndpointModelCapabilitiesSchema = z
  .object({
    tools: z.boolean().optional(),
    images: z.boolean().optional(),
  })
  .strict();

export const llmEndpointModelCompatSchema = z
  .object({
    kind: z.enum(["openai", "openrouter", "ollama", "generic"]).optional(),
    supportsDeveloperRole: z.boolean().optional(),
    supportsReasoningEffort: z.boolean().optional(),
    maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
    thinkingFormat: z.enum(["openai", "openrouter", "ollama", "none"]).optional(),
  })
  .strict();

export const llmEndpointModelSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    contextWindowTokens: z.number().int().min(1).optional(),
    maxOutputTokens: z.number().int().min(1).optional(),
    capabilities: llmEndpointModelCapabilitiesSchema.optional(),
    compat: llmEndpointModelCompatSchema.optional(),
  })
  .strict();

export const llmEndpointSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    protocol: llmProtocolSchema,
    baseUrl: llmBaseUrlSchema.optional(),
    auth: llmEndpointAuthSchema.optional(),
    headers: llmLiteralHeadersSchema.optional(),
    headerEnv: llmHeaderEnvSchema.optional(),
    models: z.record(z.string().min(1), llmEndpointModelSchema).default({}),
  })
  .strict()
  .superRefine((endpoint, context) => {
    if (!endpoint.baseUrl) return;
    const carriesCredentials =
      (endpoint.auth !== undefined && endpoint.auth.type !== "none") ||
      endpoint.headerEnv !== undefined;
    if (carriesCredentials && new URL(endpoint.baseUrl).protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "Credential-bearing LLM endpoints must use https.",
      });
    }
  });

export const llmRequestPolicySchema = z
  .object({
    timeoutMs: z.number().int().min(1000).max(MAX_LLM_REQUEST_TIMER_MS).default(120_000),
    maxRetries: z.number().int().min(0).max(10).default(2),
    baseRetryDelayMs: z.number().int().min(0).max(MAX_LLM_REQUEST_TIMER_MS).default(500),
    maxRetryDelayMs: z.number().int().min(0).max(MAX_LLM_REQUEST_TIMER_MS).default(10_000),
  })
  .refine((policy) => policy.maxRetryDelayMs >= policy.baseRetryDelayMs, {
    message: "maxRetryDelayMs must be greater than or equal to baseRetryDelayMs.",
    path: ["maxRetryDelayMs"],
  });

const nativeLlmProfileSchema = z
  .object({
    kind: z.literal("native").default("native"),
    id: z.string().min(1),
    label: z.string().trim().min(1).optional(),
    endpointId: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: llmReasoningEffortSchema.optional(),
    thinking: llmThinkingConfigSchema.optional(),
  })
  .strict();

const sessionAgentLlmProfileSchema = z
  .object({
    kind: z.literal("session-agent"),
    id: z.string().min(1),
    label: z.string().trim().min(1).optional(),
    adapterId: z.string().min(1),
    model: z.string().min(1).default("default"),
    reasoningEffort: llmReasoningEffortSchema.optional(),
    thinking: llmThinkingConfigSchema.optional(),
  })
  .strict();

export const llmProfileSchema = z.union([sessionAgentLlmProfileSchema, nativeLlmProfileSchema]);

const acpAuthMethodPreferenceSchema = z
  .object({
    id: z.string().trim().min(1),
    whenEnv: z
      .string()
      .trim()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Expected an environment variable name.")
      .optional(),
  })
  .strict();

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
        authMethodPreferences: z.array(acpAuthMethodPreferenceSchema).optional(),
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
  inheritEnv: z
    .boolean()
    .optional()
    .describe(
      "Pass the FULL parent environment (including shell secrets) to the server subprocess. Prefer envAllowlist; runtime doctor warns when inheritEnv is set without one.",
    ),
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

const appsPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .default({
    enabled: true,
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

const imagesPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    // Loaded images ride the per-turn state trail (no cache prefix), so they
    // re-bill at the full input rate every turn — keep these small. TTL 1 =
    // glance once, describe, drop the pixels; the model reloads on demand.
    maxLoaded: z.number().int().min(1).default(4),
    defaultTtlTurns: z.number().int().min(1).default(1),
    maxStored: z.number().int().min(1).default(16),
  })
  .default({
    enabled: true,
    maxLoaded: 4,
    defaultTtlTurns: 1,
    maxStored: 16,
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

// Voice plugin (STT + TTS). Endpoints mirror the LLM endpoint shape; local
// self-hosted servers are configured exactly like the `ollama` LLM endpoint —
// a `baseUrl` plus `auth: { type: "none" }`. `endpointAuthSchema` is the neutral
// auth union shared by both modalities (no `codex` variant, which is LLM-only).
export const endpointAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("env"), env: z.string().trim().min(1) }).strict(),
  z.object({ type: z.literal("secure_store") }).strict(),
]);

// Speech protocols are plain strings validated against the runtime's speech
// protocol registry at profile resolution (an unknown protocol surfaces as the
// profile's invalidReason, not a config-load crash). A closed enum here would
// prevent plugins from registering new protocols.
export const sttProtocolSchema = z.string().trim().min(1);
export const ttsProtocolSchema = z.string().trim().min(1);

const voiceSttModelSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    language: z.string().trim().min(1).optional(),
  })
  .strict();

const voiceTtsVoiceSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
  })
  .strict();

const voiceSttEndpointSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    protocol: sttProtocolSchema,
    // Wire-format variant within the protocol family (realtime-stt: openai | vllm).
    dialect: z.string().trim().min(1).default("openai"),
    baseUrl: z.string().trim().min(1).optional(),
    auth: endpointAuthSchema.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    // PCM16 input rate the service expects (OpenAI realtime requires 24000).
    sampleRate: z.number().int().min(8000).max(48000).default(16000),
    models: z.record(z.string().min(1), voiceSttModelSchema).default({}),
  })
  .strict();

const voiceTtsEndpointSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    protocol: ttsProtocolSchema,
    baseUrl: z.string().trim().min(1).optional(),
    auth: endpointAuthSchema.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    // Synthesis model (e.g. "gpt-4o-mini-tts", "kokoro"). A profile may override it.
    model: z.string().trim().min(1).optional(),
    // PCM16 rate of the service's `response_format: "pcm"` output.
    pcmSampleRate: z.number().int().min(8000).max(48000).default(24000),
    voices: z.record(z.string().min(1), voiceTtsVoiceSchema).default({}),
  })
  .strict();

const voiceSttProfileSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().trim().min(1).optional(),
    endpointId: z.string().min(1),
    model: z.string().min(1),
    language: z.string().trim().min(1).optional(),
  })
  .strict();

const voiceTtsProfileSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().trim().min(1).optional(),
    endpointId: z.string().min(1),
    voice: z.string().min(1),
    model: z.string().min(1).optional(),
    speed: z.number().min(0.25).max(4).optional(),
  })
  .strict();

const voiceSttConfigSchema = z
  .object({
    endpoints: z.record(z.string().min(1), voiceSttEndpointSchema).default({}),
    profiles: z.array(voiceSttProfileSchema).default([]),
    defaultProfileId: z.string().min(1).optional(),
  })
  .default({ endpoints: {}, profiles: [] });

const voiceTtsConfigSchema = z
  .object({
    endpoints: z.record(z.string().min(1), voiceTtsEndpointSchema).default({}),
    profiles: z.array(voiceTtsProfileSchema).default([]),
    defaultProfileId: z.string().min(1).optional(),
  })
  .default({ endpoints: {}, profiles: [] });

const voicePluginConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    stt: voiceSttConfigSchema,
    tts: voiceTtsConfigSchema,
  })
  .default({
    enabled: false,
    stt: { endpoints: {}, profiles: [] },
    tts: { endpoints: {}, profiles: [] },
  });

// Streaming voice conversation loop: mic PCM → realtime STT session → agent
// turn → streamed TTS → streamed playback. Audio I/O is swappable: `host` uses
// the local mic/speaker (dev / pre-hardware), `robot` routes audio through the
// reachy provider's affordances. STT/TTS profiles live in the `voice` plugin —
// not duplicated here.
const voiceConversationAudioConfigSchema = z
  .object({
    backend: z.enum(["host", "robot"]).default("host"),
    // Optional command overrides; both support a `{rate}` token (sample rate in
    // Hz). streamCommand must write mono signed 16-bit LE PCM to stdout at the
    // active STT endpoint's rate; playStreamCommand must play the same framing
    // from stdin. Defaults target macOS (sox `sox -d` capture / `play` output).
    streamCommand: z.array(z.string().min(1)).min(1).optional(),
    playStreamCommand: z.array(z.string().min(1)).min(1).optional(),
    streamChunkMs: z.number().min(10).max(1000).default(40),
    // Provider id supplying mic/speaker affordances when backend === "robot".
    providerId: z.string().min(1).default("reachy"),
  })
  // Strict so removed batch-era fields (captureCommand, silence*, …) fail
  // loudly instead of being silently ignored.
  .strict()
  .default({
    backend: "host",
    streamChunkMs: 40,
    providerId: "reachy",
  });

const voiceConversationEmbodimentConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    providerId: z.string().min(1).default("reachy"),
  })
  .default({ enabled: true, providerId: "reachy" });

const voiceConversationRealtimeConfigSchema = z
  .object({
    autoStartMode: z.enum(["off", "continuous"]).default("off"),
    defaultStartMode: z.enum(["single_turn", "continuous"]).default("single_turn"),
  })
  .default({ autoStartMode: "off", defaultStartMode: "single_turn" });

const voiceConversationPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    audio: voiceConversationAudioConfigSchema,
    embodiment: voiceConversationEmbodimentConfigSchema,
    realtime: voiceConversationRealtimeConfigSchema,
  })
  .default({
    enabled: false,
    audio: {
      backend: "host",
      streamChunkMs: 40,
      providerId: "reachy",
    },
    embodiment: { enabled: true, providerId: "reachy" },
    realtime: { autoStartMode: "off", defaultStartMode: "single_turn" },
  });

const pluginsConfigSchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    "persistent-goal": persistentGoalPluginConfigSchema,
    apps: appsPluginConfigSchema,
    terminal: terminalPluginConfigSchema,
    filesystem: filesystemPluginConfigSchema,
    images: imagesPluginConfigSchema,
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
    voice: voicePluginConfigSchema,
    "voice-conversation": voiceConversationPluginConfigSchema,
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
      reasoningEffort: llmReasoningEffortSchema.optional(),
      thinking: llmThinkingConfigSchema.default({}),
      endpoints: z.record(z.string().min(1), llmEndpointSchema).default({}),
      defaultProfileId: z.string().optional(),
      profiles: z.array(llmProfileSchema).default([]),
      maxTokens: z.number().int().min(256).default(4096),
      requestPolicy: llmRequestPolicySchema.default(DEFAULT_LLM_REQUEST_POLICY),
    })
    .strict()
    .default({
      thinking: {},
      endpoints: {},
      profiles: [],
      maxTokens: 4096,
      requestPolicy: DEFAULT_LLM_REQUEST_POLICY,
    }),
  agent: z
    .object({
      maxIterations: z.number().int().min(1).default(32),
      overviewDepth: z.number().int().min(1).default(2),
      detailDepth: z.number().int().min(1).default(4),
      historyTurns: z.number().int().min(1).default(8),
      toolResultMaxChars: z.number().int().min(512).default(16000),
      contextCompaction: z
        .object({
          enabled: z.boolean().default(true),
          reserveTokens: z.number().int().min(256).default(8192),
          keepRecentTokens: z.number().int().min(256).default(20000),
          summaryMaxTokens: z.number().int().min(256).default(2048),
          retryOnOverflow: z.boolean().default(true),
        })
        .default({
          enabled: true,
          reserveTokens: 8192,
          keepRecentTokens: 20000,
          summaryMaxTokens: 2048,
          retryOnOverflow: true,
        }),
      // Image content_refs in tool results (file:// on the same host) larger
      // than this are not loaded into the conversation.
      toolResultImageMaxBytes: z.number().int().min(1024).default(5_242_880),
    })
    .default({
      maxIterations: 32,
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

export type LlmProtocol = z.infer<typeof llmProtocolSchema>;
export type LlmReasoningEffort = z.infer<typeof llmReasoningEffortSchema>;
export type LlmThinkingDisplay = z.infer<typeof llmThinkingDisplaySchema>;
export type LlmThinkingConfigInput = z.infer<typeof llmThinkingConfigSchema>;
export type LlmEndpointAuthConfig = z.infer<typeof llmEndpointAuthSchema>;
export type LlmEndpointModelCapabilitiesConfig = z.infer<typeof llmEndpointModelCapabilitiesSchema>;
export type LlmEndpointModelCompatConfig = z.infer<typeof llmEndpointModelCompatSchema>;
export type LlmRequestPolicyConfig = z.infer<typeof llmRequestPolicySchema>;

export type LlmThinkingEffectiveReason =
  | "configured"
  | "model_forces_thinking"
  | "provider_unsupported"
  | "unknown";

export type LlmThinkingConfig = LlmThinkingConfigInput & {
  enabled: boolean;
  display: LlmThinkingDisplay;
  effort: LlmReasoningEffort;
};

export type LlmProfileConfig = {
  kind: "native";
  id: string;
  label?: string;
  endpointId: string;
  model: string;
  reasoningEffort?: LlmReasoningEffort;
  thinking?: LlmThinkingConfigInput;
};

export type LlmSessionAgentProfileConfig = {
  kind: "session-agent";
  id: string;
  label?: string;
  adapterId: string;
  model: string;
  reasoningEffort?: LlmReasoningEffort;
  thinking?: LlmThinkingConfigInput;
};

export type AnyLlmProfileConfig = LlmProfileConfig | LlmSessionAgentProfileConfig;

export type LlmEndpointModelConfig = {
  label?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  capabilities?: LlmEndpointModelCapabilitiesConfig;
  compat?: LlmEndpointModelCompatConfig;
};

export type LlmEndpointConfig = {
  label?: string;
  protocol: LlmProtocol;
  baseUrl?: string;
  auth: LlmEndpointAuthConfig;
  headers?: Record<string, string>;
  headerEnv?: Record<string, string>;
  models: Record<string, LlmEndpointModelConfig>;
};

export type LlmEndpointInputConfig = Omit<LlmEndpointConfig, "auth"> & {
  auth?: LlmEndpointAuthConfig;
};

export type EndpointAuthConfig = z.infer<typeof endpointAuthSchema>;
export type SttProtocol = z.infer<typeof sttProtocolSchema>;
export type TtsProtocol = z.infer<typeof ttsProtocolSchema>;
export type VoiceSttEndpointConfig = z.infer<typeof voiceSttEndpointSchema>;
export type VoiceTtsEndpointConfig = z.infer<typeof voiceTtsEndpointSchema>;
export type VoiceSttProfileConfig = z.infer<typeof voiceSttProfileSchema>;
export type VoiceTtsProfileConfig = z.infer<typeof voiceTtsProfileSchema>;
export type VoicePluginConfig = z.infer<typeof voicePluginConfigSchema>;
export type VoiceConversationPluginConfig = z.infer<typeof voiceConversationPluginConfigSchema>;

export interface LlmConfig {
  reasoningEffort?: LlmReasoningEffort;
  thinking?: LlmThinkingConfig;
  endpoints: Record<string, LlmEndpointConfig>;
  defaultProfileId?: string;
  profiles: AnyLlmProfileConfig[];
  maxTokens: number;
  requestPolicy?: LlmRequestPolicyConfig;
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
