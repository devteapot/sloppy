import {
  action,
  createSlopServer,
  type ItemDescriptor,
  type NodeDescriptor,
  type SlopServer,
} from "@slop-ai/server";
import type { SessionRuntime } from "./runtime";
import type {
  ActivityItem,
  ExternalAppSnapshot,
  LlmProfileSnapshot,
  QueuedSessionMessage,
  SessionExtensionRecord,
  TranscriptContentBlock,
  TranscriptMessage,
  TurnStateSnapshot,
} from "./types";

function parseApprovalMode(value: unknown): "normal" | "auto" {
  if (value === "normal" || value === "auto") {
    return value;
  }
  throw new Error("approval mode must be 'normal' or 'auto'.");
}

function toSnakeTurnProps(turn: TurnStateSnapshot) {
  return {
    turn_id: turn.turnId,
    state: turn.state,
    phase: turn.phase,
    iteration: turn.iteration,
    started_at: turn.startedAt,
    updated_at: turn.updatedAt,
    message: turn.message,
    last_error: turn.lastError,
    waiting_on: turn.waitingOn ?? null,
  };
}

function buildContentChildren(content: TranscriptContentBlock[]): Record<string, NodeDescriptor> {
  return Object.fromEntries(
    content.map((block) => {
      if (block.type === "media") {
        return [
          block.id,
          {
            type: "media",
            props: {
              seq: block.seq,
              mime: block.mime,
              uri: block.uri,
              name: block.name,
              summary: block.summary,
              preview: block.preview,
            },
          } satisfies NodeDescriptor,
        ];
      }
      if (block.type === "thinking") {
        return [
          block.id,
          {
            type: "document",
            props: {
              kind: "thinking_output",
              seq: block.seq,
              mime: block.mime,
              text: block.text,
              format: block.format,
              display: block.display,
              provider: block.provider,
              model: block.model,
              started_at: block.startedAt,
              completed_at: block.completedAt,
              elapsed_ms: block.elapsedMs,
              token_count: block.tokenCount,
              token_count_source: block.tokenCountSource,
            },
          } satisfies NodeDescriptor,
        ];
      }
      return [
        block.id,
        {
          type: "document",
          props: {
            seq: block.seq,
            mime: block.mime,
            text: block.text,
          },
        } satisfies NodeDescriptor,
      ];
    }),
  );
}

function buildTranscriptItem(message: TranscriptMessage): ItemDescriptor {
  return {
    id: message.id,
    props: {
      role: message.role,
      seq: message.seq,
      state: message.state,
      turn_id: message.turnId,
      created_at: message.createdAt,
      author: message.author,
      error: message.error,
    },
    summary:
      message.role === "assistant"
        ? "Assistant message"
        : message.role === "system"
          ? "System message"
          : "User message",
    children: {
      content: {
        type: "group",
        children: buildContentChildren(message.content),
      },
    },
  };
}

function queuedSummary(message: QueuedSessionMessage): string {
  return message.text.length > 96 ? `${message.text.slice(0, 93)}...` : message.text;
}

function buildActivityItem(item: ActivityItem): ItemDescriptor {
  return {
    id: item.id,
    props: {
      kind: item.kind,
      seq: item.seq,
      status: item.status,
      summary: item.summary,
      started_at: item.startedAt,
      updated_at: item.updatedAt,
      completed_at: item.completedAt,
      turn_id: item.turnId,
      provider: item.provider,
      path: item.path,
      action: item.action,
      label: item.label,
      approval_id: item.approvalId,
      task_id: item.taskId,
      tool_use_id: item.toolUseId,
      params_preview: item.paramsPreview,
      error_message: item.errorMessage,
      result: item.result,
    },
    summary: item.summary,
  };
}

function buildLlmProfileItem(profile: LlmProfileSnapshot): ItemDescriptor {
  return {
    id: profile.id,
    props: {
      label: profile.label,
      provider: profile.provider,
      model: profile.model,
      reasoning_effort: profile.reasoningEffort,
      thinking_enabled: profile.thinkingEnabled,
      thinking_display: profile.thinkingDisplay,
      thinking_effective_enabled: profile.thinkingEffectiveEnabled,
      thinking_effective_reason: profile.thinkingEffectiveReason,
      thinking_effort: profile.thinkingEffort,
      adapter_id: profile.adapterId,
      api_key_env: profile.apiKeyEnv,
      base_url: profile.baseUrl,
      context_window_tokens: profile.contextWindowTokens,
      is_default: profile.isDefault,
      has_key: profile.hasKey,
      key_source: profile.keySource,
      ready: profile.ready,
      managed: profile.managed,
      origin: profile.origin,
      can_delete_profile: profile.canDeleteProfile,
      can_delete_api_key: profile.canDeleteApiKey,
    },
    summary: `${profile.provider} ${profile.model}`,
  };
}

function buildAppItem(app: ExternalAppSnapshot): ItemDescriptor {
  return {
    id: app.id,
    props: {
      provider_id: app.id,
      name: app.name,
      transport: app.transport,
      status: app.status,
      last_error: app.lastError,
    },
    summary: `${app.name} (${app.status})`,
  };
}

function buildExtensionItem(
  extension: SessionExtensionRecord,
  clear: (namespace: string) => { status: string; namespace: string; removed: boolean },
): ItemDescriptor {
  return {
    id: extension.namespace,
    props: {
      namespace: extension.namespace,
      instance_id: extension.instanceId,
      schema_version: extension.schemaVersion,
      revision: extension.revision,
      owner: extension.owner,
      state: extension.state,
      lifecycle: extension.lifecycle,
      cleanup_policy: extension.cleanupPolicy,
      retain_until: extension.retainUntil,
      created_at: extension.createdAt,
      updated_at: extension.updatedAt,
      last_used_at: extension.lastUsedAt,
    },
    summary: `${extension.namespace} (${extension.lifecycle})`,
    actions: {
      clear_extension: action(async () => clear(extension.namespace), {
        label: "Clear Extension",
        description: "Remove this session extension metadata record.",
        dangerous: true,
        estimate: "instant",
      }),
    },
  };
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.floor(value));
}

function optionalWindow(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) {
    return undefined;
  }
  const start = optionalPositiveInteger(value[0]);
  const count = optionalPositiveInteger(value[1]);
  return start !== undefined && count !== undefined ? [start, count] : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class AgentSessionProvider {
  readonly server: SlopServer;

  private unsubscribeStore: (() => void) | null = null;

  constructor(
    private runtime: SessionRuntime,
    options?: {
      providerId?: string;
      providerName?: string;
    },
  ) {
    const snapshot = this.runtime.store.getSnapshot();
    const providerId = options?.providerId ?? `sloppy-session-${snapshot.session.sessionId}`;
    this.runtime.registerSessionProviderId(providerId);
    this.server = createSlopServer({
      id: providerId,
      name: options?.providerName ?? "Sloppy Agent Session",
    });

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("llm", () => this.buildLlmDescriptor());
    this.server.register("usage", () => this.buildUsageDescriptor());
    this.server.register("turn", () => this.buildTurnDescriptor());
    this.server.register("extensions", () => this.buildExtensionsDescriptor());
    this.server.register("plugins", () => this.runtime.buildPluginsDescriptor());
    this.server.register("composer", () => this.buildComposerDescriptor());
    this.server.register("queue", () => this.buildQueueDescriptor());
    this.server.register("transcript", () => this.buildTranscriptDescriptor());
    this.server.register("activity", () => this.buildActivityDescriptor());
    this.server.register("approvals", () => this.buildApprovalsDescriptor());
    this.server.register("tasks", () => this.buildTasksDescriptor());
    this.server.register("apps", () => this.buildAppsDescriptor());
    for (const contribution of this.runtime.getPluginSessionNodes()) {
      this.server.register(contribution.path.replace(/^\//, ""), () =>
        contribution.build(this.runtime.getPluginRuntimeContext()),
      );
    }

    this.unsubscribeStore = this.runtime.store.onChange(() => {
      this.server.refresh();
    });
  }

  stop(): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.server.stop();
  }

  private buildSessionDescriptor(): NodeDescriptor {
    const snapshot = this.runtime.store.getSnapshot();
    return {
      type: "context",
      props: {
        session_id: snapshot.session.sessionId,
        status: snapshot.session.status,
        model_provider: snapshot.session.modelProvider,
        model: snapshot.session.model,
        started_at: snapshot.session.startedAt,
        updated_at: snapshot.session.updatedAt,
        client_count: snapshot.session.clientCount,
        title: snapshot.session.title,
        workspace_root: snapshot.session.workspaceRoot,
        workspace_id: snapshot.session.workspaceId,
        project_id: snapshot.session.projectId,
        launch_scope_key: snapshot.session.launchScope?.key,
        launch_root: snapshot.session.launchScope?.root,
        last_error: snapshot.session.lastError,
        config_requires_restart: snapshot.session.configRequiresRestart === true,
        config_restart_reason: snapshot.session.configRestartReason,
        persistence_path: snapshot.session.persistencePath,
        restored_at: snapshot.session.restoredAt,
        recovered_after_restart: snapshot.session.recoveredAfterRestart === true,
        queued_count: snapshot.queue.length,
      },
      summary: "Shared state for one running Sloppy agent session.",
      actions: {
        reload_config: action(async () => this.runtime.reloadConfig(), {
          label: "Reload Config",
          description:
            "Reload this session's config from its configured scope. Provider or agent wiring changes are marked restart-required.",
          estimate: "fast",
        }),
      },
    };
  }

  private buildTurnDescriptor(): NodeDescriptor {
    const snapshot = this.runtime.store.getSnapshot();
    return {
      type: "status",
      props: toSnakeTurnProps(snapshot.turn),
      summary: "Current agent turn status.",
      actions: this.runtime.canCancelTurn()
        ? {
            cancel_turn: action(async () => this.runtime.cancelTurn(), {
              label: "Cancel Turn",
              description: "Cancel the active agent turn.",
              dangerous: true,
              estimate: "instant",
            }),
          }
        : undefined,
    };
  }

  private buildExtensionsDescriptor(): NodeDescriptor {
    const snapshot = this.runtime.store.getSnapshot();
    const extensions = Object.values(snapshot.extensions).sort((left, right) =>
      left.namespace.localeCompare(right.namespace),
    );

    return {
      type: "collection",
      props: {
        count: extensions.length,
        namespaces: extensions.map((extension) => extension.namespace),
      },
      summary:
        "Generic session extension metadata. Prefer dedicated projections such as /goal when available.",
      actions: {
        sweep_extensions: action(async () => this.runtime.sweepExtensions(), {
          label: "Sweep Extensions",
          description: "Remove extension records whose retention window has expired.",
          estimate: "instant",
        }),
      },
      items: extensions.map((extension) =>
        buildExtensionItem(extension, (namespace) => this.runtime.clearExtension(namespace)),
      ),
    };
  }

  private buildLlmDescriptor(): NodeDescriptor {
    const snapshot = this.runtime.store.getSnapshot();

    return {
      type: "collection",
      props: {
        status: snapshot.llm.status,
        message: snapshot.llm.message,
        active_profile_id: snapshot.llm.activeProfileId,
        selected_provider: snapshot.llm.selectedProvider,
        selected_model: snapshot.llm.selectedModel,
        selected_context_window_tokens: snapshot.llm.selectedContextWindowTokens,
        secure_store_kind: snapshot.llm.secureStoreKind,
        secure_store_status: snapshot.llm.secureStoreStatus,
        count: snapshot.llm.profiles.length,
      },
      summary: "Configured LLM profiles and credential readiness.",
      actions: {
        save_profile: action(
          {
            profile_id: {
              type: "string",
              description: "Optional existing profile id to update.",
            },
            label: {
              type: "string",
              description: "Optional display label for the profile.",
            },
            provider: "string",
            model: {
              type: "string",
              description: "Optional model override for the provider.",
            },
            reasoning_effort: {
              type: "string",
              description: "Optional reasoning effort for providers that expose it.",
            },
            thinking_enabled: {
              type: "boolean",
              description: "Request provider thinking/reasoning for this profile.",
            },
            thinking_display: {
              type: "string",
              description: "Default Thinking-output display mode: visible or hidden.",
            },
            adapter_id: {
              type: "string",
              description: "Optional ACP adapter id for external-agent profiles.",
            },
            base_url: {
              type: "string",
              description: "Optional base URL override.",
            },
            api_key: {
              type: "string",
              description: "Optional API key to store securely.",
            },
            make_default: {
              type: "boolean",
              description: "Set the saved profile as the default session profile.",
            },
          },
          async (params) => this.runtime.saveLlmProfile(params),
          {
            label: "Save Profile",
            description: "Create or update a persisted LLM profile and optional API key.",
            estimate: "fast",
          },
        ),
        set_default_profile: action(
          {
            profile_id: "string",
          },
          async ({ profile_id }) => this.runtime.setDefaultLlmProfile(profile_id),
          {
            label: "Set Default Profile",
            description: "Make a saved LLM profile the active default for new turns.",
            estimate: "instant",
          },
        ),
        delete_profile: action(
          {
            profile_id: "string",
          },
          async ({ profile_id }) => this.runtime.deleteLlmProfile(profile_id),
          {
            label: "Delete Profile",
            description: "Delete a saved LLM profile and its stored API key.",
            dangerous: true,
            estimate: "fast",
          },
        ),
        delete_api_key: action(
          {
            profile_id: "string",
          },
          async ({ profile_id }) => this.runtime.deleteLlmApiKey(profile_id),
          {
            label: "Delete API Key",
            description: "Delete the stored API key for a profile.",
            dangerous: true,
            estimate: "fast",
          },
        ),
      },
      items: snapshot.llm.profiles.map((profile) => buildLlmProfileItem(profile)),
    };
  }

  private buildUsageDescriptor(): NodeDescriptor {
    const usage = this.runtime.store.getSnapshot().usage;

    return {
      type: "context",
      props: {
        last_turn_id: usage.lastTurnId,
        last_model_call_input_tokens: usage.lastModelCallInputTokens,
        last_model_call_output_tokens: usage.lastModelCallOutputTokens,
        last_model_call_thinking_tokens: usage.lastModelCallThinkingTokens,
        last_model_call_input_source: usage.lastModelCallInputSource,
        last_model_call_output_source: usage.lastModelCallOutputSource,
        last_model_call_thinking_source: usage.lastModelCallThinkingSource,
        current_turn_input_tokens: usage.currentTurnInputTokens,
        current_turn_output_tokens: usage.currentTurnOutputTokens,
        current_turn_thinking_tokens: usage.currentTurnThinkingTokens,
        current_turn_model_calls: usage.currentTurnModelCalls,
        total_input_tokens: usage.totalInputTokens,
        total_output_tokens: usage.totalOutputTokens,
        total_thinking_tokens: usage.totalThinkingTokens,
        total_tokens:
          usage.totalInputTokens === undefined &&
          usage.totalOutputTokens === undefined &&
          usage.totalThinkingTokens === undefined
            ? undefined
            : (usage.totalInputTokens ?? 0) +
              (usage.totalOutputTokens ?? 0) +
              (usage.totalThinkingTokens ?? 0),
        last_state_context_tokens: usage.lastStateContextTokens,
        last_state_context_token_source: usage.lastStateContextTokenSource,
        model_context_window_tokens: usage.modelContextWindowTokens,
        available_context_tokens: usage.availableContextTokens,
        updated_at: usage.updatedAt,
      },
      summary:
        "Session-owned token accounting. State-context values describe the SLOP state tail, not the model context window.",
    };
  }

  private buildComposerDescriptor(): NodeDescriptor {
    const snapshot = this.runtime.store.getSnapshot();
    const llmReady = snapshot.llm.status === "ready";

    return {
      type: "control",
      props: {
        accepts_attachments: false,
        max_attachments: 0,
        ready: llmReady,
        disabled_reason: llmReady ? undefined : snapshot.llm.message,
        queued_count: snapshot.queue.length,
        active_turn_id: snapshot.turn.turnId,
      },
      summary: "Send a user message into the running session.",
      actions: llmReady
        ? {
            send_message: action(
              { text: "string" },
              async ({ text }) => this.runtime.sendMessage(text),
              {
                label: "Send Message",
                description:
                  "Submit a user message. Starts immediately when idle, otherwise queues it for the next turn.",
                estimate: "instant",
              },
            ),
          }
        : undefined,
    };
  }

  private buildQueueDescriptor(): NodeDescriptor {
    const snapshot = this.runtime.store.getSnapshot();
    return {
      type: "collection",
      props: {
        count: snapshot.queue.length,
      },
      summary: "Submitted user messages waiting for the current turn to finish.",
      items: snapshot.queue.map((message, index) => ({
        id: message.id,
        props: {
          status: message.status,
          text: message.text,
          created_at: message.createdAt,
          author: message.author,
          source: message.source,
          plugin_id: message.pluginId,
          plugin_run_id: message.pluginRunId,
          goal_id: message.goalId,
          continuation: message.continuation === true,
          position: index + 1,
        },
        summary: queuedSummary(message),
        actions: {
          cancel: action(async () => this.runtime.cancelQueuedMessage(message.id), {
            label: "Cancel Queued Message",
            description: "Remove this submitted message from the pending turn queue.",
            estimate: "instant",
          }),
        },
      })),
    };
  }

  private buildTranscriptDescriptor(): NodeDescriptor {
    const snapshot = this.runtime.store.getSnapshot();
    return {
      type: "collection",
      props: {
        count: snapshot.transcript.length,
      },
      summary: "Conversation transcript for the session.",
      items: snapshot.transcript.map((message) => buildTranscriptItem(message)),
    };
  }

  private buildActivityDescriptor(): NodeDescriptor {
    const snapshot = this.runtime.store.getSnapshot();
    return {
      type: "collection",
      props: {
        count: snapshot.activity.length,
      },
      summary: "Operational activity for the session.",
      items: snapshot.activity.map((item) => buildActivityItem(item)),
    };
  }

  private buildApprovalsDescriptor(): NodeDescriptor {
    const snapshot = this.runtime.store.getSnapshot();
    return {
      type: "collection",
      props: {
        count: snapshot.approvals.length,
        approval_mode: snapshot.approvalPolicy.mode,
        approval_mode_updated_at: snapshot.approvalPolicy.updatedAt,
      },
      summary: "Pending and resolved approvals for this session.",
      actions: {
        set_mode: action(
          {
            mode: {
              type: "string",
              description: "Approval mode: normal or auto.",
            },
          },
          ({ mode }) => this.runtime.setApprovalMode(parseApprovalMode(mode)),
          {
            label: "Set Approval Mode",
            description:
              "Set whether this session asks for approvals normally or automatically approves pending approvals.",
            estimate: "instant",
          },
        ),
      },
      items: snapshot.approvals.map((approval) => ({
        id: approval.id,
        props: {
          status: approval.status,
          provider: approval.provider,
          path: approval.path,
          action: approval.action,
          reason: approval.reason,
          created_at: approval.createdAt,
          resolved_at: approval.resolvedAt,
          params_preview: approval.paramsPreview,
          dangerous: approval.dangerous,
          mirror_lineage: approval.mirrorLineage,
        },
        summary: approval.reason,
        actions:
          approval.status === "pending"
            ? {
                ...(approval.canApprove
                  ? {
                      approve: action(async () => this.runtime.approveApproval(approval.id), {
                        label: "Approve",
                        description: "Approve and resume the blocked provider action.",
                        dangerous: true,
                        estimate: "fast",
                      }),
                    }
                  : {}),
                ...(approval.canReject
                  ? {
                      reject: action(
                        {
                          reason: {
                            type: "string",
                            description: "Optional rejection explanation.",
                          },
                        },
                        async ({ reason }) =>
                          this.runtime.rejectApproval(
                            approval.id,
                            typeof reason === "string" ? reason : undefined,
                          ),
                        {
                          label: "Reject",
                          description: "Reject the blocked provider action.",
                          estimate: "instant",
                        },
                      ),
                    }
                  : {}),
              }
            : undefined,
      })),
    };
  }

  private buildTasksDescriptor(): NodeDescriptor {
    const snapshot = this.runtime.store.getSnapshot();
    return {
      type: "collection",
      props: {
        count: snapshot.tasks.length,
      },
      summary: "Async downstream tasks tracked by the session.",
      items: snapshot.tasks.map((task) => ({
        id: task.id,
        props: {
          status: task.status,
          provider: task.provider,
          provider_task_id: task.providerTaskId,
          started_at: task.startedAt,
          updated_at: task.updatedAt,
          message: task.message,
          progress: task.progress,
          linked_activity_id: task.linkedActivityId,
          error: task.error,
          mirror_lineage: task.mirrorLineage,
        },
        summary: task.message,
        actions:
          task.canCancel && task.status === "running" && typeof task.sourcePath === "string"
            ? {
                cancel: action(async () => this.runtime.cancelTask(task.id), {
                  label: "Cancel",
                  description: "Forward cancellation to the downstream provider task.",
                  dangerous: true,
                  estimate: "instant",
                }),
              }
            : undefined,
      })),
    };
  }

  private buildAppsDescriptor(): NodeDescriptor {
    const snapshot = this.runtime.store.getSnapshot();
    return {
      type: "collection",
      props: {
        count: snapshot.apps.length,
      },
      summary: "External provider attachments tracked for this session.",
      items: snapshot.apps.map((app) => buildAppItem(app)),
      actions: {
        query_provider: action(
          {
            provider_id: "string",
            path: "string",
            depth: {
              type: "number",
              optional: true,
              description: "Optional query depth.",
            },
            max_nodes: {
              type: "number",
              optional: true,
              description: "Optional maximum node count.",
            },
            window: {
              type: "array",
              optional: true,
              items: { type: "number" },
              description: "Optional [start, count] item window.",
            },
          },
          async ({ provider_id, path, depth, max_nodes, window }) =>
            this.runtime.queryProviderState(String(provider_id), String(path), {
              depth: optionalPositiveInteger(depth),
              maxNodes: optionalPositiveInteger(max_nodes),
              window: optionalWindow(window),
            }),
          {
            label: "Query Provider",
            description:
              "Query state from a provider attached to this session, including in-process first-party plugin providers. Returns provider-owned SLOP nodes as-is.",
            idempotent: true,
            estimate: "fast",
          },
        ),
        invoke_provider: action(
          {
            provider_id: "string",
            path: "string",
            action: "string",
            params: {
              type: "object",
              optional: true,
              description: "JSON parameters for the provider action.",
            },
          },
          async ({ provider_id, path, action: actionName, params }) =>
            this.runtime.invokeProviderAction(
              String(provider_id),
              String(path),
              String(actionName),
              optionalRecord(params),
            ),
          {
            label: "Invoke Provider",
            description:
              "Invoke an affordance on a provider attached to this session. Hub approval policy still applies.",
            estimate: "slow",
          },
        ),
        load_provider: action(
          {
            provider_id: "string",
          },
          async ({ provider_id }) => this.runtime.loadProvider(String(provider_id)),
          {
            label: "Load Provider",
            description:
              "Connect an unloaded, disconnected, or errored external provider so its state and affordances become available again.",
            estimate: "fast",
          },
        ),
        unload_provider: action(
          {
            provider_id: "string",
          },
          async ({ provider_id }) => this.runtime.unloadProvider(String(provider_id)),
          {
            label: "Unload Provider",
            description:
              "Disconnect an external provider from the agent Hub while keeping its app card visible for later loading. Use this to reduce state/tool context for providers that are not relevant to the current task.",
            estimate: "fast",
          },
        ),
        reload_provider: action(
          {
            provider_id: "string",
          },
          async ({ provider_id }) => this.runtime.reloadProvider(String(provider_id)),
          {
            label: "Reload Provider",
            description: "Disconnect and reconnect a currently connected external provider.",
            estimate: "fast",
          },
        ),
      },
    };
  }
}
