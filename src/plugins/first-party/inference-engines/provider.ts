import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import type { EngineLlmProfileConfig } from "../../../config/schema";
import { type EngineRuntimeSnapshot, engineRuntimeRegistry } from "../../../llm/engine/registry";

export class InferenceEnginesProvider {
  readonly server: SlopServer;

  private unsubscribe: (() => void) | null = null;
  private readonly profileIds: Set<string>;

  constructor(options: { profiles: EngineLlmProfileConfig[] }) {
    this.profileIds = new Set(options.profiles.map((profile) => profile.id));
    engineRuntimeRegistry.configureProfiles(options.profiles);
    this.server = createSlopServer({
      id: "inference-engines",
      name: "Inference Engines",
    });
    this.server.register("engines", () => this.buildEnginesDescriptor());
    this.unsubscribe = engineRuntimeRegistry.onChange(() => {
      this.server.refresh();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.server.stop();
  }

  private buildEnginesDescriptor() {
    const engines = engineRuntimeRegistry
      .list()
      .filter((engine) => this.profileIds.has(engine.profileId));
    return {
      type: "collection",
      props: {
        count: engines.length,
        ready_count: engines.filter((engine) => engine.status === "ready").length,
        generating_count: engines.filter((engine) => engine.status === "generating").length,
        error_count: engines.filter((engine) => engine.status === "error").length,
      },
      summary: "Configured local inference engine endpoints and session status.",
      items: engines.map((engine) => this.buildEngineItem(engine)),
    };
  }

  private buildEngineItem(engine: EngineRuntimeSnapshot): ItemDescriptor {
    return {
      id: engine.profileId,
      props: {
        profile_id: engine.profileId,
        label: engine.label,
        engine: engine.engine,
        model: engine.descriptor?.model.id ?? engine.model,
        dialect: engine.dialect,
        transport: `${engine.transport.type}:${engine.transport.path}`,
        status: engine.status,
        protocol_version: engine.descriptor?.protocolVersion,
        engine_version: engine.descriptor?.engineVersion,
        backend: engine.descriptor?.runtime?.backend,
        context_window_tokens: engine.descriptor?.model.contextWindowTokens,
        rendered_text_input: engine.descriptor?.capabilities.renderedTextInput,
        prefix_sync: engine.descriptor?.capabilities.prefixSync,
        text_streaming: engine.descriptor?.capabilities.textStreaming,
        prefill_progress: engine.descriptor?.capabilities.prefillProgress,
        snapshots: engine.descriptor?.capabilities.snapshots,
        last_error: engine.lastError,
        updated_at: engine.updatedAt,
      },
      summary: `${engine.engine} ${engine.model} (${engine.status})`,
      actions: {
        refresh: action(async () => engineRuntimeRegistry.refresh(engine.profileId), {
          label: "Refresh",
          description: "Refresh the engine descriptor through the active backend connection.",
          idempotent: true,
          estimate: "fast",
        }),
        reconnect: action(async () => engineRuntimeRegistry.reconnect(engine.profileId), {
          label: "Reconnect",
          description: "Close and reopen the active engine backend connection.",
          estimate: "fast",
        }),
        close_session: action(
          {
            session_id: {
              type: "string",
              optional: true,
              description: "Optional engine session id. Defaults to the active session.",
            },
          },
          async ({ session_id }) =>
            engineRuntimeRegistry.closeSession(
              engine.profileId,
              typeof session_id === "string" ? session_id : undefined,
            ),
          {
            label: "Close Session",
            description: "Close an engine session through the active backend connection.",
            dangerous: true,
            estimate: "fast",
          },
        ),
      },
      children: {
        sessions: {
          type: "collection",
          props: {
            count: engine.sessions.length,
          },
          summary: "Recent engine sessions for this Sloppy profile.",
          items: engine.sessions.map((session) => ({
            id: session.sessionId,
            props: {
              session_id: session.sessionId,
              state: session.state,
              position: session.position,
              cached_prefix_tokens: session.cachedPrefixTokens,
              evaluated_tokens: session.evaluatedTokens,
              updated_at: session.updatedAt,
            },
            summary: `${session.sessionId} (${session.state})`,
          })),
        },
      },
    };
  }
}
