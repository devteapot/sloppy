import type { EngineLlmProfileConfig } from "../../config/schema";
import type {
  AssistantContentBlock,
  LlmChatOptions,
  LlmResponse,
  LlmTokenCount,
  ModelBackend,
  ModelBackendDescriptor,
} from "../types";
import { LlmAbortError, normalizeLlmAbortError } from "../types";
import { DsmlDialect } from "./dsml-dialect";
import type { EngineDescriptor, EngineEvent, EngineSyncResult } from "./protocol";
import { engineRuntimeRegistry } from "./registry";
import { UnixNdjsonEngineClient } from "./unix-ndjson-client";

export function createEngineNativeBackend(options: {
  profile: EngineLlmProfileConfig;
}): ModelBackend {
  return new EngineNativeBackend(options.profile);
}

class EngineNativeBackend implements ModelBackend {
  readonly kind = "engine" as const;

  private client: UnixNdjsonEngineClient | null = null;
  private sessionId: string | null = null;
  private descriptor: EngineDescriptor | undefined;
  private unregisterController?: () => void;

  constructor(private readonly profile: EngineLlmProfileConfig) {
    engineRuntimeRegistry.configureProfiles([profile]);
    this.unregisterController = engineRuntimeRegistry.registerController(profile.id, {
      refresh: async () => {
        await this.refreshDescriptor();
      },
      reconnect: async () => {
        await this.reconnect();
      },
      closeSession: async (sessionId) => {
        await this.closeSession(sessionId);
      },
    });
  }

  describe(): ModelBackendDescriptor {
    return {
      kind: "engine",
      profileId: this.profile.id,
      engine: this.profile.engine,
      model: this.descriptor?.model.id ?? this.profile.model,
      contextWindowTokens:
        this.descriptor?.model.contextWindowTokens ?? this.profile.contextWindowTokens,
      capabilities: {
        engineSession: true,
        prefillProgress: this.descriptor?.capabilities.prefillProgress === true,
        localSnapshots: this.descriptor?.capabilities.snapshots === true,
      },
    };
  }

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    const dialect = new DsmlDialect();
    const parser = dialect.createParser();
    const client = await this.ensureClient();
    const sessionId = await this.ensureSession(client);
    const prompt = dialect.renderPrompt({
      system: options.system,
      messages: options.messages,
      tools: options.tools ?? [],
    });
    let outputTokens = 0;
    let sync: EngineSyncResult | undefined;
    const content: AssistantContentBlock[] = [];

    const onAbort = () => {
      void client.interrupt(sessionId).catch(() => undefined);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      engineRuntimeRegistry.setStatus(this.profile, "connecting", {
        descriptor: this.descriptor,
      });
      sync = await client.sync(sessionId, {
        kind: "rendered_text",
        text: prompt,
        cacheKey: `${this.profile.id}:main`,
      });
      engineRuntimeRegistry.updateSession(this.profile, sessionId, "synced", sync);
      engineRuntimeRegistry.setStatus(this.profile, "generating", {
        descriptor: this.descriptor,
      });
      engineRuntimeRegistry.updateSession(this.profile, sessionId, "generating", sync);

      for await (const event of client.generate(sessionId, { maxTokens: options.maxTokens })) {
        if (options.signal?.aborted) {
          throw new LlmAbortError();
        }

        if (event.type === "token") {
          outputTokens += 1;
        }
        for (const block of this.consumeEngineEvent(event, parser, options.onText)) {
          appendAssistantContent(content, block);
        }
      }

      for (const event of parser.finish()) {
        if (event.type === "visible_text") {
          options.onText?.(event.text);
          appendAssistantContent(content, { type: "text", text: event.text });
        } else {
          appendAssistantContent(content, event.block);
        }
      }

      engineRuntimeRegistry.setStatus(this.profile, "ready", {
        descriptor: this.descriptor,
      });
      engineRuntimeRegistry.updateSession(this.profile, sessionId, "idle", sync);

      const hasToolUse = content.some((block) => block.type === "tool_use");
      return {
        content,
        stopReason: hasToolUse ? "tool_use" : "end_turn",
        usage: {
          inputTokens: sync?.evaluatedTokens,
          outputTokens: outputTokens > 0 ? outputTokens : undefined,
        },
      };
    } catch (error) {
      const normalized = normalizeLlmAbortError(error, options.signal);
      if (normalized instanceof LlmAbortError) {
        engineRuntimeRegistry.updateSession(this.profile, sessionId, "idle", sync);
        engineRuntimeRegistry.setStatus(this.profile, "ready", {
          descriptor: this.descriptor,
        });
        throw normalized;
      }

      const message = normalized instanceof Error ? normalized.message : String(normalized);
      engineRuntimeRegistry.updateSession(this.profile, sessionId, "error", sync);
      engineRuntimeRegistry.setStatus(this.profile, "error", {
        descriptor: this.descriptor,
        lastError: message,
      });
      throw normalized;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async countTextTokens(): Promise<LlmTokenCount> {
    return { source: "unavailable" };
  }

  async dispose(): Promise<void> {
    await this.closeSession();
    this.client?.close();
    this.client = null;
    this.unregisterController?.();
    this.unregisterController = undefined;
  }

  private consumeEngineEvent(
    event: EngineEvent,
    parser: ReturnType<DsmlDialect["createParser"]>,
    onText: ((chunk: string) => void) | undefined,
  ): AssistantContentBlock[] {
    if (event.type === "error") {
      throw new Error(event.message);
    }
    if (event.type !== "text" && event.type !== "token") {
      return [];
    }

    const text = event.type === "text" ? event.text : (event.text ?? "");
    if (!text) {
      return [];
    }

    const blocks: AssistantContentBlock[] = [];
    for (const parserEvent of parser.feed(text)) {
      if (parserEvent.type === "visible_text") {
        onText?.(parserEvent.text);
        blocks.push({ type: "text", text: parserEvent.text });
      } else {
        blocks.push(parserEvent.block);
      }
    }
    return blocks;
  }

  private async ensureClient(): Promise<UnixNdjsonEngineClient> {
    if (this.client) {
      return this.client;
    }

    if (this.profile.transport.type !== "unix") {
      throw new Error(`Unsupported engine transport: ${this.profile.transport.type}`);
    }

    this.client = new UnixNdjsonEngineClient(this.profile.transport.path);
    await this.refreshDescriptor();
    return this.client;
  }

  private async ensureSession(client: UnixNdjsonEngineClient): Promise<string> {
    if (this.sessionId) {
      return this.sessionId;
    }

    const session = await client.createSession({
      contextWindowTokens: this.profile.contextWindowTokens,
      metadata: {
        sloppyProfileId: this.profile.id,
      },
    });
    this.sessionId = session.sessionId;
    engineRuntimeRegistry.updateSession(this.profile, session.sessionId, "created");
    return session.sessionId;
  }

  private async refreshDescriptor(): Promise<void> {
    const client = this.client ?? new UnixNdjsonEngineClient(this.profile.transport.path);
    if (!this.client) {
      this.client = client;
    }
    this.descriptor = await client.describe();
    engineRuntimeRegistry.setStatus(this.profile, "ready", {
      descriptor: this.descriptor,
    });
  }

  private async reconnect(): Promise<void> {
    this.client?.close();
    this.client = null;
    this.sessionId = null;
    await this.ensureClient();
  }

  private async closeSession(sessionId = this.sessionId ?? undefined): Promise<void> {
    if (!sessionId || !this.client) {
      return;
    }
    await this.client.destroySession(sessionId).catch(() => undefined);
    engineRuntimeRegistry.updateSession(this.profile, sessionId, "closed");
    if (this.sessionId === sessionId) {
      this.sessionId = null;
    }
  }
}

function appendAssistantContent(
  content: AssistantContentBlock[],
  block: AssistantContentBlock,
): void {
  const previous = content[content.length - 1];
  if (block.type === "text" && previous?.type === "text") {
    previous.text += block.text;
    return;
  }
  content.push(block);
}
