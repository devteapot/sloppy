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
  TranscriptContentBlock,
  TranscriptMessage,
  TurnStateSnapshot,
} from "./types";

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
              mime: block.mime,
              uri: block.uri,
              name: block.name,
              summary: block.summary,
              preview: block.preview,
            },
          } satisfies NodeDescriptor,
        ];
      }
      return [
        block.id,
        {
          type: "document",
          props: {
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

function buildActivityItem(item: ActivityItem): ItemDescriptor {
  return {
    id: item.id,
    props: {
      kind: item.kind,
      status: item.status,
      summary: item.summary,
      started_at: item.startedAt,
      updated_at: item.updatedAt,
      completed_at: item.completedAt,
      turn_id: item.turnId,
      provider: item.provider,
      path: item.path,
      action: item.action,
      approval_id: item.approvalId,
      task_id: item.taskId,
      tool_use_id: item.toolUseId,
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
      adapter_id: profile.adapterId,
      api_key_env: profile.apiKeyEnv,
      base_url: profile.baseUrl,
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
    this.server = createSlopServer({
      id: options?.providerId ?? `sloppy-session-${snapshot.session.sessionId}`,
      name: options?.providerName ?? "Sloppy Agent Session",
    });

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("llm", () => this.buildLlmDescriptor());
    this.server.register("turn", () => this.buildTurnDescriptor());
    this.server.register("composer", () => this.buildComposerDescriptor());
    this.server.register("transcript", () => this.buildTranscriptDescriptor());
    this.server.register("activity", () => this.buildActivityDescriptor());
    this.server.register("approvals", () => this.buildApprovalsDescriptor());
    this.server.register("tasks", () => this.buildTasksDescriptor());
    this.server.register("apps", () => this.buildAppsDescriptor());

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
        last_error: snapshot.session.lastError,
      },
      summary: "Shared state for one running Sloppy agent session.",
      meta: {
        salience: 1,
        focus: true,
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
            adapter_id: {
              type: "string",
              description: "Optional ACP/CLI adapter id for external-agent profiles.",
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
      },
      summary: "Send a user message into the running session.",
      actions: llmReady
        ? {
            send_message: action(
              { text: "string" },
              async ({ text }) => this.runtime.sendMessage(text),
              {
                label: "Send Message",
                description: "Append a user message and start a new turn.",
                estimate: "instant",
              },
            ),
          }
        : undefined,
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
      },
      summary: "Pending and resolved approvals for this session.",
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
        },
        summary: task.message,
        actions: task.canCancel
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
    };
  }
}
