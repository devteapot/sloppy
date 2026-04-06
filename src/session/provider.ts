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
    content.map((block) => [
      block.id,
      {
        type: "document",
        props: {
          mime: block.mime,
          text: block.text,
        },
      } satisfies NodeDescriptor,
    ]),
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
    },
    summary: item.summary,
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
    this.server.register("turn", () => this.buildTurnDescriptor());
    this.server.register("composer", () => this.buildComposerDescriptor());
    this.server.register("transcript", () => this.buildTranscriptDescriptor());
    this.server.register("activity", () => this.buildActivityDescriptor());
    this.server.register("approvals", () => this.buildApprovalsDescriptor());
    this.server.register("tasks", () => this.buildTasksDescriptor());

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

  private buildComposerDescriptor(): NodeDescriptor {
    return {
      type: "control",
      props: {
        accepts_attachments: false,
        max_attachments: 0,
      },
      summary: "Send a user message into the running session.",
      actions: {
        send_message: action(
          { text: "string" },
          async ({ text }) => this.runtime.sendMessage(text),
          {
            label: "Send Message",
            description: "Append a user message and start a new turn.",
            estimate: "instant",
          },
        ),
      },
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
}
