export type EngineWireMethod =
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

export type EngineWireError = {
  code:
    | "unsupported"
    | "invalid_request"
    | "session_not_found"
    | "busy"
    | "interrupted"
    | "engine_error";
  message: string;
  retryable?: boolean;
};

export type EngineWireRequest = {
  type: "request";
  id: string;
  method: EngineWireMethod;
  params?: Record<string, unknown>;
};

export type EngineWireResponse =
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
    };

export type EngineWireEvent = {
  type: "event";
  id: string;
  event: EngineEvent;
};

export type EngineWireMessage = EngineWireRequest | EngineWireResponse | EngineWireEvent;

export type EngineDescriptor = {
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
  runtime?: {
    backend?: string;
    host?: string;
    pid?: number;
  };
  capabilities: {
    renderedTextInput: boolean;
    tokenInput?: boolean;
    tokenization?: boolean;
    prefixSync: boolean;
    prefillProgress?: boolean;
    tokenStreaming?: boolean;
    textStreaming: boolean;
    logprobs?: boolean;
    rewind?: boolean;
    snapshots?: boolean;
    persistentKv?: boolean;
    batching?: boolean;
    speculativeDecode?: boolean;
  };
};

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

export type EngineSyncResult = {
  sessionId: string;
  position?: number;
  contextWindowTokens?: number;
  cachedPrefixTokens?: number;
  evaluatedTokens?: number;
  rebuilt?: boolean;
  promptHash?: string;
};

export type EngineEvent =
  | { type: "prefill_progress"; current: number; total?: number }
  | { type: "token"; id: number; text?: string; logprob?: number }
  | { type: "text"; text: string }
  | { type: "metrics"; prefillTps?: number; generationTps?: number; kvBytes?: number }
  | { type: "done"; reason: "eos" | "stop" | "max_tokens" | "interrupted" }
  | { type: "error"; code?: string; message: string };

export type EngineGenerateOptions = {
  maxTokens: number;
  temperature?: number;
  topP?: number;
  minP?: number;
  topK?: number;
  seed?: number;
  stop?: string[];
};
