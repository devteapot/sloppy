/**
 * Hub-owned approval queue. Single source of truth for any policy-mediated or
 * provider-native approval request. Per-provider `/approvals` SLOP collections
 * (built by `ProviderApprovalManager`) read filtered views of this queue when
 * attached to it; otherwise they fall back to a per-provider internal store.
 */

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalRecord {
  id: string;
  providerId: string;
  path: string;
  action: string;
  reason: string;
  paramsPreview?: string;
  dangerous?: boolean;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
  resolutionReason?: string;
}

export type ApprovalEvent = "requested" | "approved" | "rejected";

type EnqueueOptions = Omit<ApprovalRecord, "id" | "createdAt" | "status" | "resolvedAt"> & {
  execute: () => unknown | Promise<unknown>;
  reject?: (reason?: string) => void;
};

interface QueuedApproval extends ApprovalRecord {
  execute: () => unknown | Promise<unknown>;
  rejectCallback?: (reason?: string) => void;
}

function buildApprovalId(): string {
  return `approval-${crypto.randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class ApprovalQueue {
  private items = new Map<string, QueuedApproval>();
  private listeners = new Map<ApprovalEvent, Set<(id: string) => void>>();

  enqueue(options: EnqueueOptions): string {
    const id = buildApprovalId();
    const record: QueuedApproval = {
      id,
      providerId: options.providerId,
      path: options.path,
      action: options.action,
      reason: options.reason,
      paramsPreview: options.paramsPreview,
      dangerous: options.dangerous,
      status: "pending",
      createdAt: nowIso(),
      execute: options.execute,
      rejectCallback: options.reject,
    };
    this.items.set(id, record);
    this.emit("requested", id);
    return id;
  }

  list(filter?: { providerId?: string }): ApprovalRecord[] {
    const out: ApprovalRecord[] = [];
    for (const item of this.items.values()) {
      if (filter?.providerId && item.providerId !== filter.providerId) {
        continue;
      }
      out.push(this.snapshot(item));
    }
    return out;
  }

  get(id: string): ApprovalRecord | undefined {
    const item = this.items.get(id);
    return item ? this.snapshot(item) : undefined;
  }

  async approve(id: string): Promise<unknown> {
    const item = this.requirePending(id);
    item.status = "approved";
    item.resolvedAt = nowIso();
    this.emit("approved", id);
    return await item.execute();
  }

  reject(id: string, reason?: string): void {
    const item = this.requirePending(id);
    item.status = "rejected";
    item.resolutionReason = reason;
    item.resolvedAt = nowIso();
    try {
      item.rejectCallback?.(reason);
    } catch {
      // best-effort
    }
    this.emit("rejected", id);
  }

  on(event: ApprovalEvent, handler: (id: string) => void): () => void {
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(event, bucket);
    }
    bucket.add(handler);
    return () => {
      bucket?.delete(handler);
    };
  }

  private requirePending(id: string): QueuedApproval {
    const item = this.items.get(id);
    if (!item) {
      throw new Error(`Unknown approval: ${id}`);
    }
    if (item.status !== "pending") {
      throw new Error(`Approval is already resolved: ${id}`);
    }
    return item;
  }

  private snapshot(item: QueuedApproval): ApprovalRecord {
    return {
      id: item.id,
      providerId: item.providerId,
      path: item.path,
      action: item.action,
      reason: item.reason,
      paramsPreview: item.paramsPreview,
      dangerous: item.dangerous,
      status: item.status,
      createdAt: item.createdAt,
      resolvedAt: item.resolvedAt,
      resolutionReason: item.resolutionReason,
    };
  }

  private emit(event: ApprovalEvent, id: string): void {
    const bucket = this.listeners.get(event);
    if (!bucket) {
      return;
    }
    for (const handler of bucket) {
      try {
        handler(id);
      } catch {
        // best-effort
      }
    }
  }
}
