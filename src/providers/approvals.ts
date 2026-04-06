import { AsyncActionResult } from "@slop-ai/core";
import { action, type ItemDescriptor, type NodeDescriptor, type SlopServer } from "@slop-ai/server";

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

type ApprovalRecord = {
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
  return `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

export class ProviderApprovalManager {
  private approvals = new Map<string, ApprovalRecord>();

  constructor(private server: SlopServer) {}

  request(options: {
    path: string;
    action: string;
    reason: string;
    paramsPreview?: string;
    dangerous?: boolean;
    execute: () => unknown | Promise<unknown>;
  }): string {
    const approval: ApprovalRecord = {
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
    this.approvals.set(approval.id, approval);
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
    return {
      type: "collection",
      props: {
        count: this.approvals.size,
      },
      summary: "Provider-native approval requests.",
      items: [...this.approvals.values()].map((approval) => this.buildItem(approval)),
    };
  }

  private buildItem(approval: ApprovalRecord): ItemDescriptor {
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
              approve: action(async () => this.approve(approval.id), {
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
                  },
                },
                async ({ reason }) =>
                  this.reject(approval.id, typeof reason === "string" ? reason : undefined),
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

  private async approve(approvalId: string): Promise<unknown> {
    const approval = this.requirePendingApproval(approvalId);
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

  private async reject(
    approvalId: string,
    reason?: string,
  ): Promise<{ approvalId: string; status: string }> {
    const approval = this.requirePendingApproval(approvalId);
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

  private requirePendingApproval(approvalId: string): ApprovalRecord {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      throw new Error(`Unknown approval: ${approvalId}`);
    }

    if (approval.status !== "pending") {
      throw new Error(`Approval is already resolved: ${approvalId}`);
    }

    return approval;
  }
}
