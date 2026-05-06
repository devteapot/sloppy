import type { AgentCallbacks, AgentToolInvocation } from "../core/agent";
import type { ExternalProviderState } from "../core/consumer";
import { parseApprovalsTree, parseTasksTree } from "./provider-mirrors";
import type { SessionStore } from "./store";
import type { ExternalAppSnapshot } from "./types";

type ProviderSnapshotUpdate = Parameters<NonNullable<AgentCallbacks["onProviderSnapshot"]>>[0];

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
): void {
  if (update.path === "/approvals") {
    const approvals = parseApprovalsTree(update.providerId, update.tree, pendingApproval);
    const matchedApproval = approvals.find(
      (approval) => approval.turnId === pendingApproval?.turnId,
    );
    if (matchedApproval && pendingApproval && !pendingApproval.sessionApprovalId) {
      pendingApproval.sessionApprovalId = matchedApproval.id;
    }
    store.syncProviderApprovals(update.providerId, approvals);
    return;
  }

  store.syncProviderTasks(update.providerId, parseTasksTree(update.providerId, update.tree));
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
