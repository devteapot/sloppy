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
  SessionOrchestrationGate,
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

function toSnakeGateProps(gate: SessionOrchestrationGate): Record<string, unknown> {
  return {
    id: gate.id,
    source_gate_id: gate.sourceGateId,
    gate_type: gate.gateType,
    status: gate.status,
    subject_ref: gate.subjectRef,
    summary: gate.summary,
    evidence_refs: gate.evidenceRefs,
    created_at: gate.createdAt,
    version: gate.version,
    can_accept: gate.canAccept,
    can_reject: gate.canReject,
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
    this.server.register("orchestration", () => this.buildOrchestrationDescriptor());

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

  private buildOrchestrationDescriptor(): NodeDescriptor {
    const summary = this.runtime.store.getSnapshot().orchestration;
    return {
      type: "status",
      props: {
        available: summary.available,
        provider: summary.provider,
        plan_id: summary.planId,
        plan_status: summary.planStatus,
        plan_version: summary.planVersion,
        final_audit_id: summary.finalAuditId,
        final_audit_status: summary.finalAuditStatus ?? "none",
        latest_digest_id: summary.latestDigestId,
        latest_digest_status: summary.latestDigestStatus,
        pending_digest_delivery_count: summary.pendingDigestDeliveryCount,
        latest_digest_delivery_error: summary.latestDigestDeliveryError,
        latest_digest_actions: summary.latestDigestActions.map((digestAction) => ({
          id: digestAction.id,
          kind: digestAction.kind,
          label: digestAction.label,
          target_ref: digestAction.targetRef,
          action_path: digestAction.actionPath,
          action_name: digestAction.actionName,
          params: digestAction.params,
          urgency: digestAction.urgency,
        })),
        pending_gate_count: summary.pendingGateCount,
        latest_blocking_gate_id: summary.latestBlockingGateId,
        latest_blocking_gate_type: summary.latestBlockingGateType,
        latest_blocking_gate_summary: summary.latestBlockingGateSummary,
        pending_gates: summary.pendingGates.map((gate) => toSnakeGateProps(gate)),
        active_slice_count: summary.activeSliceCount,
        completed_slice_count: summary.completedSliceCount,
        failed_slice_count: summary.failedSliceCount,
        precedent_resolved_count: summary.precedentResolvedCount,
        semantic_precedent_resolved_count: summary.semanticPrecedentResolvedCount,
        precedent_escalated_count: summary.precedentEscalatedCount,
        open_drift_event_count: summary.openDriftEventCount,
        blocking_drift_event_count: summary.blockingDriftEventCount,
        progress_criteria_total: summary.progressCriteriaTotal,
        progress_criteria_satisfied: summary.progressCriteriaSatisfied,
        progress_criteria_unknown: summary.progressCriteriaUnknown,
        progress_prior_distance: summary.progressPriorDistance,
        progress_current_distance: summary.progressCurrentDistance,
        progress_velocity: summary.progressVelocity,
        goal_revision_pressure: summary.goalRevisionPressure,
        latest_goal_revision_magnitude: summary.latestGoalRevisionMagnitude,
        coherence_breaches: summary.coherenceBreaches ?? [],
        coherence_thresholds: summary.coherenceThresholds ?? {},
        updated_at: summary.updatedAt,
      },
      summary: summary.available
        ? `Orchestration plan ${summary.planStatus ?? "none"}; ${summary.pendingGateCount} gate(s) pending.`
        : "No orchestration provider state mirrored for this session.",
      meta: {
        salience:
          summary.pendingGateCount > 0 ||
          summary.finalAuditStatus === "failed" ||
          (summary.blockingDriftEventCount ?? 0) > 0 ||
          summary.latestDigestDeliveryError
            ? 0.9
            : 0.45,
        urgency:
          summary.pendingGateCount > 0 ||
          summary.finalAuditStatus === "failed" ||
          (summary.blockingDriftEventCount ?? 0) > 0 ||
          summary.latestDigestDeliveryError
            ? "high"
            : "low",
      },
      actions: {
        start_spec_driven_goal: action(
          {
            intent: "string",
            title: {
              type: "string",
              description: "Optional goal title. Defaults to Spec-driven goal.",
              optional: true,
            },
            spec_body: {
              type: "string",
              description: "Optional initial spec body drafted by the spec agent.",
              optional: true,
            },
            requirements: {
              type: "array",
              description:
                "Optional spec requirements: { text, priority?, tags?, criterion_kind?, verification_hint? }.",
              items: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  priority: {
                    type: "string",
                    enum: ["must", "should", "could"],
                    optional: true,
                  },
                  tags: {
                    type: "array",
                    items: { type: "string" },
                    optional: true,
                  },
                  criterion_kind: {
                    type: "string",
                    enum: ["code", "text"],
                    optional: true,
                  },
                  verification_hint: { type: "string", optional: true },
                },
                required: ["text"],
                additionalProperties: false,
              },
              optional: true,
            },
            slices: {
              type: "array",
              description:
                "Optional planner slice set. When auto_accept_spec is true, this creates a plan revision.",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  goal: { type: "string" },
                  kind: {
                    type: "string",
                    enum: ["implementation", "audit", "repair", "docs", "verification"],
                    optional: true,
                  },
                  client_ref: { type: "string", optional: true },
                  depends_on: {
                    type: "array",
                    items: { type: "string" },
                    optional: true,
                  },
                  spec_refs: {
                    type: "array",
                    items: { type: "string" },
                    optional: true,
                  },
                  acceptance_criteria: {
                    type: "array",
                    items: { type: "string" },
                    optional: true,
                  },
                  planner_assumptions: {
                    type: "array",
                    items: { type: "string" },
                    optional: true,
                  },
                  structural_assumptions: {
                    type: "array",
                    items: { type: "string" },
                    optional: true,
                  },
                  slice_gate_resolver: {
                    type: "string",
                    enum: ["user", "policy"],
                    optional: true,
                  },
                },
                required: ["name", "goal"],
                additionalProperties: false,
              },
              optional: true,
            },
            auto_accept_spec: {
              type: "boolean",
              description: "Resolve the spec_accept gate and freeze the draft spec immediately.",
              optional: true,
            },
            auto_accept_plan: {
              type: "boolean",
              description:
                "Resolve the plan_accept gate and create schedulable slices immediately. Requires auto_accept_spec.",
              optional: true,
            },
            strategy: { type: "string", optional: true },
            max_agents: { type: "number", optional: true },
            planned_commit: { type: "string", optional: true },
            slice_gate_resolver: {
              type: "string",
              enum: ["user", "policy"],
              optional: true,
            },
            budget: {
              type: "object",
              description:
                "Optional plan-scoped budget. Supports wall_time_ms, retries_per_slice, token_limit, and cost_usd.",
              optional: true,
            },
          },
          async (params) => this.runtime.startSpecDrivenGoal(params),
          {
            label: "Start Spec Goal",
            description:
              "Start the docs/12 goal -> spec -> plan pipeline through the session runtime.",
            estimate: "fast",
          },
        ),
        accept_gate: action(
          {
            gate_id: "string",
            resolution: {
              type: "string",
              description: "Optional rationale for accepting the gate.",
              optional: true,
            },
          },
          async ({ gate_id, resolution }) =>
            this.runtime.acceptOrchestrationGate(
              String(gate_id),
              typeof resolution === "string" ? resolution : undefined,
            ),
          {
            label: "Accept Gate",
            description: "Accept a pending orchestration gate through the downstream provider.",
            estimate: "instant",
          },
        ),
        reject_gate: action(
          {
            gate_id: "string",
            resolution: {
              type: "string",
              description: "Optional rationale for rejecting the gate.",
              optional: true,
            },
          },
          async ({ gate_id, resolution }) =>
            this.runtime.rejectOrchestrationGate(
              String(gate_id),
              typeof resolution === "string" ? resolution : undefined,
            ),
          {
            label: "Reject Gate",
            description: "Reject a pending orchestration gate through the downstream provider.",
            estimate: "instant",
          },
        ),
        run_digest_action: action(
          {
            action_id: "string",
          },
          async ({ action_id }) => this.runtime.runDigestAction(String(action_id)),
          {
            label: "Run Digest Action",
            description: "Invoke one of the latest digest's typed control actions.",
            dangerous: true,
            estimate: "instant",
          },
        ),
      },
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
