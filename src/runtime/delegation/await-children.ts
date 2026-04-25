import type { SlopNode } from "@slop-ai/consumer/browser";

import type { ConsumerHub } from "../../core/consumer";
import { debug } from "../../core/debug";
import type { ProviderTreeView } from "../../core/subscriptions";
import { LlmAbortError } from "../../llm/types";

const DELEGATED_WORK_SUSPEND_TIMEOUT_MS = 5 * 60_000;
const STATE_CHANGE_WAIT_SLICE_MS = 30_000;
const ACTIVE_AGENT_STATUSES = new Set(["pending", "running"]);

function getNodeProperties(node: SlopNode): Record<string, unknown> {
  const properties = node.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return {};
  }
  return properties as Record<string, unknown>;
}

function walkTree(node: SlopNode, visit: (node: SlopNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) {
    walkTree(child, visit);
  }
}

function hasPendingChildApproval(view: ProviderTreeView): boolean {
  let found = false;
  walkTree(view.overviewTree, (node) => {
    const properties = getNodeProperties(node);
    const pendingApprovals = properties.pending_approvals;
    if (Array.isArray(pendingApprovals) && pendingApprovals.length > 0) {
      found = true;
    }
    if (properties.state === "waiting_approval") {
      found = true;
    }
  });
  if (view.detailTree) {
    walkTree(view.detailTree, (node) => {
      const properties = getNodeProperties(node);
      if (properties.state === "waiting_approval") {
        found = true;
      }
    });
  }
  return found;
}

function hasSuspensibleDelegatedWork(
  views: ProviderTreeView[],
  delegationProviderId: string,
): boolean {
  const delegationView = views.find((view) => view.providerId === delegationProviderId);
  if (!delegationView || hasPendingChildApproval(delegationView)) {
    return false;
  }

  let activeAgent = false;
  walkTree(delegationView.overviewTree, (node) => {
    const properties = getNodeProperties(node);
    if (typeof properties.status === "string" && ACTIVE_AGENT_STATUSES.has(properties.status)) {
      activeAgent = true;
    }
  });

  return activeAgent;
}

export function createAwaitChildrenHook(options: { delegationProviderId?: string } = {}) {
  const delegationProviderId = options.delegationProviderId ?? "delegation";
  return async function awaitChildren(hub: ConsumerHub, signal?: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    let logged = false;

    while (hasSuspensibleDelegatedWork(hub.getProviderViews(), delegationProviderId)) {
      if (signal?.aborted) {
        throw new LlmAbortError();
      }

      const elapsed = Date.now() - startedAt;
      const remaining = DELEGATED_WORK_SUSPEND_TIMEOUT_MS - elapsed;
      if (remaining <= 0) {
        debug("loop", "delegated_work_suspend_timeout", {
          timeout_ms: DELEGATED_WORK_SUSPEND_TIMEOUT_MS,
        });
        return;
      }

      if (!logged) {
        debug("loop", "delegated_work_suspend", {
          timeout_ms: DELEGATED_WORK_SUSPEND_TIMEOUT_MS,
        });
        logged = true;
      }

      const revision = hub.getStateRevision();
      await hub.waitForStateChange(revision, {
        timeoutMs: Math.min(STATE_CHANGE_WAIT_SLICE_MS, remaining),
        signal,
      });
    }
  };
}
