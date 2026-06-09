import type { AgentCallbacks, AgentToolInvocation } from "../core/agent";
import type { ExternalProviderState } from "../core/consumer";
import { parseApprovalsTree, parseTasksTree } from "./provider-mirrors";
import type { SessionStore } from "./store";
import type { ExternalAppSnapshot } from "./types";

type ProviderSnapshotUpdate = Parameters<NonNullable<AgentCallbacks["onProviderSnapshot"]>>[0];

/**
 * Provider tree paths the session mirrors into its public snapshot. Single
 * source of truth for mirror watching (runtime.ts mirrorProviderPaths), the
 * snapshot dispatch below, and the auto-approval trigger.
 */
export const SESSION_MIRROR_PATHS = {
  approvals: "/approvals",
  tasks: "/tasks",
} as const;

export const SESSION_MIRROR_PATH_LIST: string[] = Object.values(SESSION_MIRROR_PATHS);

export type PendingApprovalMirror = {
  turnId: string;
  invocation: AgentToolInvocation;
  sourceApprovalId: string;
  sessionApprovalId?: string;
};

export function toSessionApps(states: ExternalProviderState[]): ExternalAppSnapshot[] {
  return states.map((state) => ({
    id: state.id,
    name: state.name,
    transport: state.transport,
    status: state.status,
    lastError: state.lastError,
  }));
}

export function syncProviderSnapshotToSession(
  store: SessionStore,
  update: ProviderSnapshotUpdate,
  pendingApproval: PendingApprovalMirror | null,
  options?: {
    localProviderIds?: Iterable<string>;
  },
): void {
  if (update.path === SESSION_MIRROR_PATHS.approvals) {
    const approvals = parseApprovalsTree(update.providerId, update.tree, pendingApproval, {
      localProviderIds: options?.localProviderIds,
    });
    const matchedApproval = approvals.find(
      (approval) => approval.turnId === pendingApproval?.turnId,
    );
    if (matchedApproval && pendingApproval && !pendingApproval.sessionApprovalId) {
      pendingApproval.sessionApprovalId = matchedApproval.id;
    }
    store.syncProviderApprovals(update.providerId, approvals);
    return;
  }

  if (update.path === SESSION_MIRROR_PATHS.tasks) {
    store.syncProviderTasks(
      update.providerId,
      parseTasksTree(update.providerId, update.tree, {
        localProviderIds: options?.localProviderIds,
      }),
    );
    return;
  }
}

export function syncExternalProviderStatesToSession(
  store: SessionStore,
  states: ExternalProviderState[],
): void {
  const currentApps = store.getSnapshot().apps;
  const nextConnectedAppIds = new Set(
    states.filter((state) => state.status === "connected").map((state) => state.id),
  );

  for (const app of currentApps) {
    if (app.status === "connected" && !nextConnectedAppIds.has(app.id)) {
      store.clearProviderMirrors(app.id);
    }
  }

  store.syncApps(toSessionApps(states));
}
