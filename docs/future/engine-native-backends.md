# Engine-Native Model Backends

## Status

Partially implemented on the Sloppy runtime side.

The checked-in runtime now supports `llm.profiles[].kind: engine` for
DS4-compatible Unix NDJSON endpoints, a Sloppy-owned `dsml` tool dialect, a mock
engine integration test path, and an `inference-engines` SLOP status mirror.
Patching DS4 or any other inference engine to expose the protocol remains out
of scope for this repository change.

## Goal

Add an engine-agnostic, stateful local inference path alongside the existing
hosted/API adapter path.

The runtime should be able to use local engines such as DS4, llama.cpp, vLLM,
MLX/oMLX, and SGLang without translating every turn through an
OpenAI/Anthropic-style chat/tool API. Engines should expose inference/session
primitives; Sloppy should keep ownership of SLOP provider state, affordance
resolution, approvals, transcript shape, and public UI/session surfaces.

## Core Distinction

Sloppy should support two model backend families:

- API backends: hosted or API-compatible services that own chat request shape,
  tool schema format, streaming protocol, and often token accounting.
- Engine-native backends: local or nearby inference engines that expose a
  stateful session/prefix/KV boundary and stream generated text or tokens.

Both families should feed the same public session provider and user-facing
runtime behavior.

```text
Remote UI/TUI/dashboard
        |
        v
Public agent-session provider
        |
        v
ModelTurnBackend
  |                       |
  v                       v
API adapter backend       Engine-native backend
OpenAI/Anthropic/etc.     DS4/llama.cpp/vLLM/MLX/SGLang
        |                       |
        v                       v
ConsumerHub and SLOP providers remain the capability substrate
```

## Non-Goals

- Do not remove OpenAI, Anthropic, Gemini, OpenRouter, Ollama, OpenAI Codex, or
  ACP profile support.
- Do not make token generation a model-visible tool or ordinary provider
  affordance.
- Do not require every engine to implement KV snapshots, rewind, token-level
  APIs, or batching. These are negotiated capabilities.
- Do not put filesystem, terminal, MCP, A2A, or other Sloppy capabilities inside
  inference engines.
- Do not turn the engine protocol into a replacement for SLOP. Engines expose
  inference primitives; Sloppy may mirror engine status as SLOP state.

## Terms

- Model backend: the internal Sloppy boundary that can run one model turn.
- API adapter: a model backend backed by a hosted/API-compatible chat service.
- Engine driver: a Sloppy client for one engine protocol endpoint.
- Engine session: a stateful inference timeline or request-continuation context
  owned by an engine.
- Tool dialect: a model/prompt-specific format for presenting tools and parsing
  emitted tool calls, such as DSML, Harmony-style calls, Qwen-style tags, or a
  strict JSON block.
- Engine provider mirror: a SLOP provider inside Sloppy that exposes engine
  status, sessions, metrics, and controls to UIs and operators.

## Internal Backend Boundary

The current `LlmAdapter.chat(...)` shape is API-oriented. Add a higher-level
backend boundary that can wrap both current adapters and engine-native runners.

```ts
export interface ModelBackendDescriptor {
  kind: "api" | "engine";
  profileId: string;
  provider?: string;
  engine?: string;
  model: string;
  contextWindowTokens?: number;
  capabilities: {
    hostedToolCalling?: boolean;
    engineSession?: boolean;
    prefillProgress?: boolean;
    localSnapshots?: boolean;
  };
}

export interface ModelTurnBackend {
  kind: "api" | "engine";
  describe(): ModelBackendDescriptor;
  runTurn(input: ModelTurnInput): AsyncIterable<ModelTurnEvent>;
  countTextTokens?(text: string, options?: { signal?: AbortSignal }): Promise<LlmTokenCount>;
}

export interface ModelTurnInput {
  system: string;
  messages: ConversationMessage[];
  stateContext: string;
  tools: LlmTool[];
  maxTokens: number;
  signal?: AbortSignal;
}

export type ModelTurnEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "assistant_content";
      content: AssistantContentBlock[];
      stopReason: LlmResponse["stopReason"];
    }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | {
      type: "progress";
      phase: "prefill" | "generation";
      current: number;
      total?: number;
      message?: string;
    }
  | { type: "error"; message: string; code?: string };
```

API adapters can be lifted into this interface by calling the existing
`LlmAdapter.chat(...)`. Engine-native backends use an engine driver plus a tool
dialect and emit the same assistant/tool-use content that the current loop
already understands.

## Engine Session Protocol

Patch local engines to expose a small, versioned, sessionful protocol. The
protocol can run over Unix socket, stdio, localhost HTTP/WebSocket, or another
trusted local transport. Network exposure should require explicit config.

The minimum useful surface:

```ts
export interface EngineSessionOptions {
  sessionId?: string;
  contextWindowTokens?: number;
  metadata?: Record<string, string>;
}

export interface EngineSessionHandle {
  sessionId: string;
}

export interface EngineSyncOptions {
  allowRebuild?: boolean;
}

export interface EngineGenerateOptions {
  maxTokens: number;
  temperature?: number;
  topP?: number;
  minP?: number;
  topK?: number;
  seed?: number;
  stop?: string[];
}

export interface EngineTokenization {
  tokens: number[];
  textHash?: string;
}

export interface InferenceEngine {
  describe(): Promise<EngineDescriptor>;
  createSession(options: EngineSessionOptions): Promise<EngineSessionHandle>;
  destroySession(sessionId: string): Promise<void>;
}

export interface EngineSession {
  sync(input: EnginePromptPrefix, options?: EngineSyncOptions): Promise<EngineSyncResult>;
  generate(options: EngineGenerateOptions): AsyncIterable<EngineEvent>;
  interrupt(): Promise<void>;
  close(): Promise<void>;

  tokenize?(input: string): Promise<EngineTokenization>;
  detokenize?(tokens: number[]): Promise<string>;
  rewind?(position: number): Promise<EngineRewindResult>;
  saveSnapshot?(): Promise<EngineSnapshot>;
  loadSnapshot?(snapshot: EngineSnapshot): Promise<EngineSyncResult>;
}
```

## Wire Protocol V1

Use a small JSON envelope for the first engine protocol. NDJSON over stdio or a
Unix socket should be the reference transport because it is easy to patch into C,
C++, Python, and Rust engines. HTTP/WebSocket transports can carry the same
request, response, and event shapes.

```ts
export type EngineWireMessage =
  | {
      type: "request";
      id: string;
      method: EngineMethod;
      params?: Record<string, unknown>;
    }
  | {
      type: "response";
      id: string;
      ok: true;
      result?: unknown;
    }
  | {
      type: "response";
      id: string;
      ok: false;
      error: EngineWireError;
    }
  | {
      type: "event";
      id: string;
      event: EngineEvent;
    };

export type EngineMethod =
  | "engine.describe"
  | "session.create"
  | "session.destroy"
  | "session.sync"
  | "session.generate"
  | "session.interrupt"
  | "session.tokenize"
  | "session.detokenize"
  | "session.rewind"
  | "session.save_snapshot"
  | "session.load_snapshot";

export interface EngineWireError {
  code:
    | "unsupported"
    | "invalid_request"
    | "session_not_found"
    | "busy"
    | "interrupted"
    | "engine_error";
  message: string;
  retryable?: boolean;
}
```

`session.generate` returns an initial response when generation is accepted, then
streams `event` messages with the same request id until a terminal `done` or
`error` event. Engines that cannot overlap generation requests for the same
session should return `busy`.

### Descriptor

Every engine endpoint reports capabilities before Sloppy creates a session.

```ts
export interface EngineDescriptor {
  protocol: "sloppy.engine";
  protocolVersion: 1;
  engine: string;
  engineVersion?: string;
  model: {
    id: string;
    family?: string;
    contextWindowTokens?: number;
    tokenizer?: string;
    chatTemplate?: string;
  };
  runtime: {
    backend?: "metal" | "cuda" | "rocm" | "cpu" | string;
    host?: string;
    pid?: number;
  };
  capabilities: {
    renderedTextInput: boolean;
    tokenInput: boolean;
    tokenization: boolean;
    prefixSync: boolean;
    prefillProgress: boolean;
    tokenStreaming: boolean;
    textStreaming: boolean;
    logprobs: boolean;
    rewind: boolean;
    snapshots: boolean;
    persistentKv: boolean;
    batching: boolean;
    speculativeDecode: boolean;
  };
}
```

The common denominator is `renderedTextInput + prefixSync + textStreaming`.
Engines that can accept tokens, return token IDs, rewind, or save KV snapshots
advertise those optional capabilities.

### Prompt Prefixes

Sloppy should normally send rendered prompt text because chat templates and
tool dialects are model-specific. Token input is optional for engines that can
share a stable tokenizer contract.

```ts
export type EnginePromptPrefix =
  | {
      kind: "rendered_text";
      text: string;
      cacheKey?: string;
    }
  | {
      kind: "tokens";
      tokens: number[];
      cacheKey?: string;
    };

export interface EngineSyncResult {
  sessionId: string;
  position: number;
  contextWindowTokens?: number;
  cachedPrefixTokens?: number;
  evaluatedTokens?: number;
  rebuilt?: boolean;
  promptHash?: string;
}

export interface EngineRewindResult {
  sessionId: string;
  position: number;
}

export interface EngineSnapshot {
  sessionId: string;
  format: string;
  bytes?: Uint8Array;
  uri?: string;
  tokenPosition?: number;
}
```

`cacheKey` is Sloppy's hint that the stable prefix should be reusable. The
engine remains authoritative about actual reuse.

### Generation Events

Engines stream inference events. They do not need to understand Sloppy tools.
The dialect parser in Sloppy observes generated text and turns model-emitted
tool syntax into `ToolUseContentBlock`s.

```ts
export type EngineEvent =
  | { type: "prefill_progress"; current: number; total?: number }
  | { type: "token"; id: number; text?: string; logprob?: number }
  | { type: "text"; text: string }
  | { type: "metrics"; prefillTps?: number; generationTps?: number; kvBytes?: number }
  | { type: "done"; reason: "eos" | "stop" | "max_tokens" | "interrupted" }
  | { type: "error"; code?: string; message: string };
```

Token and text events may both be present. Sloppy should use text for dialect
parsing unless a dialect explicitly needs token IDs.

## Tool Dialects

Tool calling stays above the engine protocol.

```ts
export interface ToolDialect {
  id: string;
  renderSystemTools(input: {
    system: string;
    tools: LlmTool[];
  }): string;
  renderMessages(input: {
    messages: ConversationMessage[];
    stateContext: string;
  }): string;
  createParser(): ToolDialectParser;
  renderToolResult(result: ToolResultContentBlock): string;
}

export interface ToolDialectParser {
  feed(text: string): ToolDialectParserEvent[];
  finish(): ToolDialectParserEvent[];
}

export type ToolDialectParserEvent =
  | { type: "visible_text"; text: string }
  | { type: "tool_use"; block: ToolUseContentBlock }
  | { type: "malformed_tool_use"; message: string; raw?: string };
```

Dialect responsibilities:

- render the model's tool instructions from Sloppy's `RuntimeToolSet`
- preserve the ephemeral `<slop-state>` context tail behavior
- parse streaming model output into visible assistant text and tool calls
- render tool results back into the model's expected continuation format
- decide whether exact sampled tool-call text must be preserved for future
  prefix reuse

Initial dialect candidates:

- `dsml` for DS4-style native tool stanzas
- `json-block` for strict generic local-model experiments
- `harmony` for models that expect Harmony-like tool syntax
- `qwen-tools` for Qwen-family local coding models

## Engine Provider Mirror

For state-first visibility, Sloppy should expose configured engines as SLOP
state. This is a mirror/control surface, not the inference call path.

```text
[root] inference-engines
  [collection] engines (count=1)
    [item] ds4-local (engine="ds4", status="ready", transport="unix", model="deepseek-v4-flash")
      [status] health (loaded=true, backend="metal", last_error=null)
      [collection] sessions
        [item] main (state="generating", position=18420, cached_prefix_tokens=17102)
      [collection] metrics
      [collection] snapshots
      actions: reconnect, warm, close_idle_sessions
```

The public session provider can summarize active engine state through `/llm`,
`/usage`, `/turn`, `/activity`, and `/tasks` without requiring UIs to know the
engine protocol.

## Configuration Direction

Keep existing API profiles. Add a profile kind so API and engine profiles do
not pretend to be the same shape.

```yaml
llm:
  defaultProfileId: openai-main
  profiles:
    - id: openai-main
      kind: api
      provider: openai
      model: gpt-5.4
      apiKeyEnv: OPENAI_API_KEY

    - id: ds4-local
      kind: engine
      engine: ds4
      model: deepseek-v4-flash
      dialect: dsml
      contextWindowTokens: 1000000
      transport:
        type: unix
        path: /tmp/ds4-engine.sock

    - id: vllm-local
      kind: engine
      engine: vllm
      model: qwen3-coder
      dialect: qwen-tools
      transport:
        type: http
        url: http://127.0.0.1:9009
```

Possible later addition:

```yaml
engines:
  ds4-local:
    launch:
      command: ["ds4-engine", "--model", "/models/ds4.gguf"]
      cwd: "~/dev/ds4-og"
```

Launch management should be optional. Connecting to already-running engines is
the first target.

## Backend Responsibilities

Sloppy owns:

- conversation and transcript state
- state context tail construction and escaping
- tool inventory from SLOP provider affordances
- tool approval policy and invocation through `ConsumerHub`
- tool result formatting
- session queueing, cancellation, activity, usage, and public UI state
- compaction strategy and durable public session snapshots

The engine owns:

- model weights and backend runtime
- tokenizer and optional chat-template metadata
- prefix/KV cache, request scheduling, or continuation state
- sampling and generation
- prefill/generation progress and low-level metrics
- optional KV snapshot/rewind/persistence

Tool dialects own:

- prompt rendering for a model family
- model-native tool-call syntax
- incremental parsing of generated tool calls
- rendering tool results for continuation

## Engine-Specific Fit

DS4:

- Strong fit for the full engine-native path.
- Already has `ds4_engine`, `ds4_session`, `ds4_session_sync`, token streaming,
  progress callbacks, rewind, and snapshot/payload helpers.

llama.cpp:

- Good fit if patched to expose stable session/slot control, prefix sync,
  generated text streaming, interruption, and optional state save/load.

vLLM:

- Treat as a stateful scheduling engine rather than a raw KV owner.
- It may expose prefix-cache/session semantics without rewind or snapshots.
- Batching remains engine-owned and should appear as a capability, not a Sloppy
  scheduler responsibility.

MLX/oMLX:

- Likely starts as a local Python or native sidecar with rendered text input,
  text streaming, and cancellation.
- Token-level and snapshot capabilities can follow later.

SGLang:

- Similar to vLLM: useful for sessionful generation and server-side scheduling,
  but snapshots and arbitrary rewind may be unavailable.

## Error And Cancellation Semantics

- `interrupt` should be best-effort and scoped to the engine session.
- If the engine cannot interrupt a specific request, it must report that in the
  descriptor or return a structured error.
- Engine errors should not crash Sloppy. The active turn should fail with a
  visible `/turn.last_error`, and the engine mirror should keep `last_error`.
- A broken engine backend should not affect SLOP providers or hosted API
  profiles.

## Security

- Local Unix sockets or stdio are preferred.
- TCP/HTTP transports must bind to localhost by default and require explicit
  config for remote hosts.
- Engine protocol messages must not carry API keys or secure-store secrets.
- Engines are not allowed to invoke Sloppy affordances directly.
- Tool execution remains inside Sloppy's `ConsumerHub` policy and approval
  system.

## Implementation Phases

1. Done: add a backend descriptor shape and keep current API adapters on the
   existing `LlmAdapter.chat(...)` loop surface.
2. Done: add a Unix NDJSON engine client, DSML dialect, and deterministic mock
   engine integration tests.
3. Done: add the `inference-engines` provider mirror with `/engines` and recent
   `/sessions` state.
4. Next: add a conformance test harness that any patched engine can run against.
5. Next: integrate an already-running DS4-compatible endpoint from Sloppy.
6. Next: add llama.cpp or MLX/oMLX as the second engine to prove the protocol is
   not DS4-shaped.
7. Later: evaluate vLLM/SGLang and adjust capability negotiation for
   scheduler-style engines.

## Test Plan

- Unit-test API-adapter wrapping through `ModelTurnBackend`.
- Unit-test engine event normalization and cancellation.
- Unit-test dialect parsing for visible text, complete tool calls, malformed
  tool calls, and partial streaming boundaries.
- Integration-test engine-native turns against a mock engine and mock SLOP
  providers.
- Verify approval suspension/resume still works when the model backend is
  engine-native.
- Add optional live engine tests gated behind an environment flag, similar to
  live LLM e2e tests.

## Open Questions

- Should exact sampled tool-call text be preserved in Sloppy transcript for all
  engine dialects, or only for dialects that require it for prefix reuse?
- Should engine sessions be long-lived per Sloppy session by default, or should
  Sloppy allow a pool of engine sessions for future multi-agent local runs?
- How much chat-template metadata should the engine report versus the dialect
  owning it completely?
- Is the v1 NDJSON envelope enough for HTTP/WebSocket transports, or should
  those transports get a stricter mapping once a second engine is implemented?
- Where should persistent engine snapshots live when both Sloppy and the engine
  can persist state?
