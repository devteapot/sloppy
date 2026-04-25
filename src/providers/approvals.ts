import { AsyncActionResult } from "@slop-ai/core";
import { action, type ItemDescriptor, type NodeDescriptor, type SlopServer } from "@slop-ai/server";

import type { ApprovalQueue, ApprovalRecord } from "../core/approvals";

export const APPROVAL_REQUIRED_ERROR_CODE = "approval_required";
export const APPROVAL_REJECTED_ERROR_CODE = "approval_rejected";
export const APPROVAL_REQUESTED_EVENT = "approval.requested";
export const APPROVAL_RESOLVED_EVENT = "approval.resolved";

export type ProviderApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalResolutionPayload = {
  approvalId: string;
  path: string;
  action: string;
  status: ProviderApprovalStatus;
  resolvedAt: string;
  reason?: string;
  result?: {
    status: "ok" | "error" | "accepted";
    data?: unknown;
    error?: {
      code: string;
      message: string;
    };
  };
};

type LocalApprovalRecord = {
  id: string;
  path: string;
  action: string;
  status: ProviderApprovalStatus;
  reason: string;
  createdAt: string;
  resolvedAt?: string;
  paramsPreview?: string;
  dangerous?: boolean;
  resolutionReason?: string;
  execute: () => unknown | Promise<unknown>;
};

function now(): string {
  return new Date().toISOString();
}

function buildApprovalId(): string {
  return `approval-${crypto.randomUUID()}`;
}

function normalizeResultPayload(value: unknown): ApprovalResolutionPayload["result"] {
  if (value instanceof AsyncActionResult) {
    return {
      status: "accepted",
      data: {
        taskId: value.taskId,
        ...(value.data ?? {}),
      },
    };
  }

  if (value === undefined) {
    return {
      status: "ok",
    };
  }

  return {
    status: "ok",
    data: value,
  };
}

function normalizeError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: string };
    return {
      code: withCode.code ?? "internal",
      message: error.message,
    };
  }

  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; message?: unknown };
    return {
      code: typeof candidate.code === "string" ? candidate.code : "internal",
      message:
        typeof candidate.message === "string" ? candidate.message : JSON.stringify(candidate),
    };
  }

  return {
    code: "internal",
    message: String(error),
  };
}

export function createApprovalRequiredError(message: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = APPROVAL_REQUIRED_ERROR_CODE;
  return error;
}

/**
 * Per-provider façade over approvals. When attached to the hub-owned
 * `ApprovalQueue` via `setQueue(...)`, requests and the SLOP `/approvals`
 * collection are backed by the shared queue (filtered by `providerId`).
 * When unattached, falls back to a per-provider in-memory store so providers
 * (and their unit tests) work standalone.
 */
export class ProviderApprovalManager {
  private localApprovals = new Map<string, LocalApprovalRecord>();
  private queue: ApprovalQueue | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(private server: SlopServer) {}

  setQueue(queue: ApprovalQueue | null): void {
    // Detach previous subscriptions if any.
    for (const off of this.unsubscribers) {
      try {
        off();
      } catch {
        // best-effort
      }
    }
    this.unsubscribers = [];
    this.queue = queue;
    if (!queue) {
      return;
    }
    const refresh = (id: string) => {
      const record = queue.get(id);
      if (record && record.providerId !== this.server.id) {
        return;
      }
      this.server.refresh();
    };
    this.unsubscribers.push(queue.on("requested", refresh));
    this.unsubscribers.push(queue.on("approved", refresh));
    this.unsubscribers.push(queue.on("rejected", refresh));
    this.server.refresh();
  }

  request(options: {
    path: string;
    action: string;
    reason: string;
    paramsPreview?: string;
    dangerous?: boolean;
    execute: () => unknown | Promise<unknown>;
  }): string {
    if (this.queue) {
      const id = this.queue.enqueue({
        providerId: this.server.id,
        path: options.path,
        action: options.action,
        reason: options.reason,
        paramsPreview: options.paramsPreview,
        dangerous: options.dangerous,
        execute: options.execute,
      });
      this.server.emitEvent(APPROVAL_REQUESTED_EVENT, {
        approvalId: id,
        path: options.path,
        action: options.action,
        reason: options.reason,
        createdAt: now(),
        paramsPreview: options.paramsPreview,
        dangerous: options.dangerous,
      });
      return id;
    }

    const approval: LocalApprovalRecord = {
      id: buildApprovalId(),
      path: options.path,
      action: options.action,
      status: "pending",
      reason: options.reason,
      createdAt: now(),
      paramsPreview: options.paramsPreview,
      dangerous: options.dangerous,
      execute: options.execute,
    };
    this.localApprovals.set(approval.id, approval);
    this.server.refresh();
    this.server.emitEvent(APPROVAL_REQUESTED_EVENT, {
      approvalId: approval.id,
      path: approval.path,
      action: approval.action,
      reason: approval.reason,
      createdAt: approval.createdAt,
      paramsPreview: approval.paramsPreview,
      dangerous: approval.dangerous,
    });
    return approval.id;
  }

  buildDescriptor(): NodeDescriptor {
    if (this.queue) {
      const records = this.queue.list({ providerId: this.server.id });
      return {
        type: "collection",
        props: {
          count: records.length,
        },
        summary: "Provider-native approval requests.",
        items: records.map((record) => this.buildItemFromRecord(record)),
      };
    }

    return {
      type: "collection",
      props: {
        count: this.localApprovals.size,
      },
      summary: "Provider-native approval requests.",
      items: [...this.localApprovals.values()].map((approval) => this.buildLocalItem(approval)),
    };
  }

  private buildItemFromRecord(record: ApprovalRecord): ItemDescriptor {
    const pending = record.status === "pending";
    return {
      id: record.id,
      props: {
        status: record.status,
        provider: this.server.id,
        path: record.path,
        action: record.action,
        reason: record.reason,
        created_at: record.createdAt,
        resolved_at: record.resolvedAt,
        params_preview: record.paramsPreview,
        dangerous: record.dangerous,
        resolution_reason: record.resolutionReason,
      },
      summary: record.reason,
      actions: pending
        ? {
            approve: action(async () => this.approveQueueId(record.id), {
              label: "Approve",
              description: "Approve and run the blocked action.",
              dangerous: true,
              estimate: "fast",
            }),
            reject: action(
              {
                reason: {
                  type: "string",
                  description: "Optional explanation for the rejection.",
                  optional: true,
                },
              },
              async ({ reason }) =>
                this.rejectQueueId(record.id, typeof reason === "string" ? reason : undefined),
              {
                label: "Reject",
                description: "Reject the blocked action.",
                estimate: "instant",
              },
            ),
          }
        : undefined,
    };
  }

  private buildLocalItem(approval: LocalApprovalRecord): ItemDescriptor {
    return {
      id: approval.id,
      props: {
        status: approval.status,
        provider: this.server.id,
        path: approval.path,
        action: approval.action,
        reason: approval.reason,
        created_at: approval.createdAt,
        resolved_at: approval.resolvedAt,
        params_preview: approval.paramsPreview,
        dangerous: approval.dangerous,
        resolution_reason: approval.resolutionReason,
      },
      summary: approval.reason,
      actions:
        approval.status === "pending"
          ? {
              approve: action(async () => this.approveLocal(approval.id), {
                label: "Approve",
                description: "Approve and run the blocked action.",
                dangerous: true,
                estimate: "fast",
              }),
              reject: action(
                {
                  reason: {
                    type: "string",
                    description: "Optional explanation for the rejection.",
                    optional: true,
                  },
                },
                async ({ reason }) =>
                  this.rejectLocal(approval.id, typeof reason === "string" ? reason : undefined),
                {
                  label: "Reject",
                  description: "Reject the blocked action.",
                  estimate: "instant",
                },
              ),
            }
          : undefined,
    };
  }

  private async approveQueueId(approvalId: string): Promise<unknown> {
    const queue = this.queue;
    if (!queue) {
      throw new Error("Approval queue is not attached.");
    }
    const record = queue.get(approvalId);
    if (!record) {
      throw new Error(`Unknown approval: ${approvalId}`);
    }
    const resolvedAt = now();
    try {
      const result = await queue.approve(approvalId);
      this.server.emitEvent(APPROVAL_RESOLVED_EVENT, {
        approvalId,
        path: record.path,
        action: record.action,
        status: "approved",
        resolvedAt,
        result: normalizeResultPayload(result),
      } satisfies ApprovalResolutionPayload);
      return result;
    } catch (error) {
      this.server.emitEvent(APPROVAL_RESOLVED_EVENT, {
        approvalId,
        path: record.path,
        action: record.action,
        status: "approved",
        resolvedAt,
        result: {
          status: "error",
          error: normalizeError(error),
        },
      } satisfies ApprovalResolutionPayload);
      throw error;
    }
  }

  private async rejectQueueId(
    approvalId: string,
    reason?: string,
  ): Promise<{ approvalId: string; status: string }> {
    const queue = this.queue;
    if (!queue) {
      throw new Error("Approval queue is not attached.");
    }
    const record = queue.get(approvalId);
    if (!record) {
      throw new Error(`Unknown approval: ${approvalId}`);
    }
    const resolvedAt = now();
    queue.reject(approvalId, reason);
    this.server.emitEvent(APPROVAL_RESOLVED_EVENT, {
      approvalId,
      path: record.path,
      action: record.action,
      status: "rejected",
      resolvedAt,
      reason,
      result: {
        status: "error",
        error: {
          code: APPROVAL_REJECTED_ERROR_CODE,
          message: reason ? `Approval rejected: ${reason}` : "Approval rejected.",
        },
      },
    } satisfies ApprovalResolutionPayload);
    return {
      approvalId,
      status: "rejected",
    };
  }

  private async approveLocal(approvalId: string): Promise<unknown> {
    const approval = this.requirePendingLocalApproval(approvalId);
    const resolvedAt = now();
    approval.status = "approved";
    approval.resolvedAt = resolvedAt;
    this.server.refresh();

    try {
      const result = await approval.execute();
      this.server.emitEvent(APPROVAL_RESOLVED_EVENT, {
        approvalId: approval.id,
        path: approval.path,
        action: approval.action,
        status: approval.status,
        resolvedAt,
        result: normalizeResultPayload(result),
      } satisfies ApprovalResolutionPayload);
      return result;
    } catch (error) {
      this.server.emitEvent(APPROVAL_RESOLVED_EVENT, {
        approvalId: approval.id,
        path: approval.path,
        action: approval.action,
        status: approval.status,
        resolvedAt,
        result: {
          status: "error",
          error: normalizeError(error),
        },
      } satisfies ApprovalResolutionPayload);
      throw error;
    }
  }

  private async rejectLocal(
    approvalId: string,
    reason?: string,
  ): Promise<{ approvalId: string; status: string }> {
    const approval = this.requirePendingLocalApproval(approvalId);
    const resolvedAt = now();
    approval.status = "rejected";
    approval.resolutionReason = reason;
    approval.resolvedAt = resolvedAt;
    this.server.refresh();
    this.server.emitEvent(APPROVAL_RESOLVED_EVENT, {
      approvalId: approval.id,
      path: approval.path,
      action: approval.action,
      status: approval.status,
      resolvedAt,
      reason,
      result: {
        status: "error",
        error: {
          code: APPROVAL_REJECTED_ERROR_CODE,
          message: reason ? `Approval rejected: ${reason}` : "Approval rejected.",
        },
      },
    } satisfies ApprovalResolutionPayload);
    return {
      approvalId: approval.id,
      status: approval.status,
    };
  }

  private requirePendingLocalApproval(approvalId: string): LocalApprovalRecord {
    const approval = this.localApprovals.get(approvalId);
    if (!approval) {
      throw new Error(`Unknown approval: ${approvalId}`);
    }

    if (approval.status !== "pending") {
      throw new Error(`Approval is already resolved: ${approvalId}`);
    }

    return approval;
  }
}
