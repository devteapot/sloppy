import type { SlopNode } from "@slop-ai/consumer/browser";

import type { AgentToolInvocation } from "../core/agent";
import { buildMirroredItemId } from "./store";
import type { ApprovalItem, SessionTask, SessionTaskStatus } from "./types";

function hasAffordance(node: SlopNode, action: string): boolean {
  return (node.affordances ?? []).some((affordance) => affordance.action === action);
}

function normalizeTaskStatus(status: unknown): SessionTaskStatus {
  switch (status) {
    case "completed":
    case "done":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "superseded":
      return "superseded";
    default:
      return "running";
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function sourceMirrorLineage(properties: Record<string, unknown>): string[] {
  return stringArray(properties.mirror_lineage);
}

function hasLocalMirrorLineage(args: {
  localProviderIds: Set<string>;
  properties: Record<string, unknown>;
  lineage: string[];
}): boolean {
  const { localProviderIds, properties, lineage } = args;
  if (localProviderIds.size === 0) {
    return false;
  }

  const sourceProvider = typeof properties.provider === "string" ? properties.provider : undefined;
  if (sourceProvider && localProviderIds.has(sourceProvider)) {
    return true;
  }

  for (const entry of lineage) {
    if (localProviderIds.has(entry)) {
      return true;
    }
  }

  return false;
}

export function parseApprovalsTree(
  providerId: string,
  tree: SlopNode | null,
  pendingApproval: {
    turnId: string;
    invocation: AgentToolInvocation;
    sourceApprovalId: string;
  } | null,
  options?: {
    localProviderIds?: Iterable<string>;
  },
): ApprovalItem[] {
  if (!tree?.children) {
    return [];
  }

  const localProviderIds = new Set(options?.localProviderIds ?? []);
  if (localProviderIds.has(providerId)) {
    return [];
  }

  return tree.children.flatMap((node) => {
    const properties = node.properties ?? {};
    const lineage = sourceMirrorLineage(properties);
    if (
      hasLocalMirrorLineage({
        localProviderIds,
        properties,
        lineage,
      })
    ) {
      return [];
    }

    const item: ApprovalItem = {
      id: buildMirroredItemId("approval", providerId, node.id),
      status:
        properties.status === "approved" ||
        properties.status === "rejected" ||
        properties.status === "expired"
          ? properties.status
          : "pending",
      provider: providerId,
      path: typeof properties.path === "string" ? properties.path : "/",
      action: typeof properties.action === "string" ? properties.action : "unknown",
      reason:
        typeof properties.reason === "string" ? properties.reason : "Provider approval requested.",
      createdAt:
        typeof properties.created_at === "string"
          ? properties.created_at
          : new Date().toISOString(),
      resolvedAt: typeof properties.resolved_at === "string" ? properties.resolved_at : undefined,
      paramsPreview:
        typeof properties.params_preview === "string" ? properties.params_preview : undefined,
      dangerous: typeof properties.dangerous === "boolean" ? properties.dangerous : undefined,
      sourceApprovalId: node.id,
      sourcePath: `/approvals/${node.id}`,
      mirrorLineage: [providerId, ...lineage],
      canApprove: hasAffordance(node, "approve"),
      canReject: hasAffordance(node, "reject"),
    };

    if (
      pendingApproval &&
      item.status === "pending" &&
      item.provider === pendingApproval.invocation.providerId &&
      item.sourceApprovalId === pendingApproval.sourceApprovalId
    ) {
      item.turnId = pendingApproval.turnId;
    }

    return [item];
  });
}

export function parseTasksTree(
  providerId: string,
  tree: SlopNode | null,
  options?: {
    localProviderIds?: Iterable<string>;
  },
): SessionTask[] {
  if (!tree?.children) {
    return [];
  }

  const localProviderIds = new Set(options?.localProviderIds ?? []);
  if (localProviderIds.has(providerId)) {
    return [];
  }

  const tasks = tree.children.flatMap((node) => {
    const properties = node.properties ?? {};
    const lineage = sourceMirrorLineage(properties);
    if (
      hasLocalMirrorLineage({
        localProviderIds,
        properties,
        lineage,
      })
    ) {
      return [];
    }

    const sourceTaskId =
      typeof properties.provider_task_id === "string"
        ? properties.provider_task_id
        : typeof properties.task_id === "string"
          ? properties.task_id
          : node.id;

    return [
      {
        id: buildMirroredItemId("task", providerId, sourceTaskId),
        status: normalizeTaskStatus(properties.status),
        provider: providerId,
        providerTaskId: sourceTaskId,
        startedAt:
          typeof properties.started_at === "string"
            ? properties.started_at
            : typeof properties.startedAt === "string"
              ? properties.startedAt
              : new Date().toISOString(),
        updatedAt:
          typeof properties.updated_at === "string"
            ? properties.updated_at
            : new Date().toISOString(),
        message:
          typeof properties.message === "string"
            ? properties.message
            : typeof properties.summary === "string"
              ? properties.summary
              : "Provider task update",
        progress: typeof properties.progress === "number" ? properties.progress : undefined,
        error: typeof properties.error === "string" ? properties.error : undefined,
        sourceTaskId,
        sourcePath: `/tasks/${node.id}`,
        mirrorLineage: [providerId, ...lineage],
        canCancel: hasAffordance(node, "cancel"),
      } satisfies SessionTask,
    ];
  });

  return [...new Map(tasks.map((task) => [task.id, task])).values()];
}
