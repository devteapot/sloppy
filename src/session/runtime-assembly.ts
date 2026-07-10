import type { SloppyConfig } from "../config/schema";
import type { AgentCallbacks, RoleProfile } from "../core/agent";
import type { InvokePolicy } from "../core/policy";
import type { RoleRegistry } from "../core/role";
import type { LlmProfileManager } from "../llm/profile-manager";
import { createFirstPartyToolEventEnrichers } from "../plugins/first-party/session-facets";
import type { ChildSessionFactory } from "../runtime/child-session";
import { type AgentEventBus, createAgentEventBus } from "./event-bus";
import type { ExternalSessionAgentState } from "./llm-state";
import { toExternalAgentLlmState } from "./llm-state";
import {
  SESSION_MIRROR_PATHS,
  syncExternalProviderStatesToSession,
  syncProviderSnapshotToSession,
} from "./mirror-sync";
import type { SessionRuntimePlugin } from "./plugins";
import type { SessionAgentFactory } from "./runtime-contracts";
import {
  mergePluginExtensionEventTypes,
  resolveInitialLlmRoute,
  resolveSessionPersistencePath,
} from "./runtime-helpers";
import { SessionStore } from "./store";
import type { TurnCoordinator } from "./turn-coordinator";
import type { ApprovalMode } from "./types";

export type SessionRuntimeOptions = {
  config?: SloppyConfig;
  sessionId?: string;
  title?: string;
  store?: SessionStore;
  agentFactory?: SessionAgentFactory;
  llmProfileManager?: LlmProfileManager;
  ignoredProviderIds?: string[];
  parentActorId?: string;
  taskId?: string;
  role?: RoleProfile;
  roleId?: string;
  roleRegistry?: RoleRegistry;
  actorKind?: string;
  actorName?: string;
  actorId?: string;
  launchScope?: { key: string; root: string };
  requiresLlmProfile?: boolean;
  externalAgentState?: ExternalSessionAgentState;
  llmProfileId?: string;
  llmModelOverride?: string;
  policyRules?: InvokePolicy[];
  sessionPersistencePath?: string | false;
  approvalMode?: ApprovalMode;
  configReloader?: () => Promise<SloppyConfig>;
  childSessionFactory?: ChildSessionFactory;
};

export function createSessionStore(
  options: SessionRuntimeOptions,
  config: SloppyConfig,
  sessionId: string,
  plugins: SessionRuntimePlugin[],
): SessionStore {
  if (options.store) return options.store;
  const initialLlmRoute = resolveInitialLlmRoute(config);
  return new SessionStore({
    sessionId,
    modelProvider: initialLlmRoute.endpointId,
    model: initialLlmRoute.model,
    title: options.title,
    workspaceRoot: config.plugins.filesystem.root,
    workspaceId: config.workspaces?.activeWorkspaceId,
    projectId: config.workspaces?.activeProjectId,
    launchScope: options.launchScope,
    persistencePath: resolveSessionPersistencePath(
      config,
      sessionId,
      options.sessionPersistencePath,
    ),
    snapshotMigrators: plugins.flatMap((plugin) =>
      plugin.migrateSnapshot ? [plugin.migrateSnapshot] : [],
    ),
    snapshotRecoverers: plugins.flatMap((plugin) =>
      plugin.recoverSnapshot ? [plugin.recoverSnapshot] : [],
    ),
    snapshotProjections: plugins.flatMap((plugin) => plugin.snapshotProjections ?? []),
    extensionEventTypes: mergePluginExtensionEventTypes(plugins),
  });
}

export function createLocalProviderIds(
  sessionId: string,
  ignoredProviderIds: string[] = [],
): Set<string> {
  return new Set([...ignoredProviderIds, `sloppy-session-${sessionId}`]);
}

export function syncExternalRuntimeLlmState(
  store: SessionStore,
  externalAgentState?: ExternalSessionAgentState,
): void {
  store.syncLlmState(
    toExternalAgentLlmState(externalAgentState ?? { provider: "external", model: "agent" }),
  );
}

export function createSessionCallbacks(options: {
  store: SessionStore;
  localProviderIds: Set<string>;
  turns: () => TurnCoordinator;
}): AgentCallbacks {
  return {
    onText: (chunk) => {
      const turnId = options.turns().snapshot().activeTurnId;
      if (turnId) options.store.appendAssistantText(turnId, chunk);
    },
    onThinking: (delta) => {
      const turnId = options.turns().snapshot().activeTurnId;
      if (!turnId) return;
      options.store.appendAssistantThinking(turnId, {
        blockId: delta.id,
        provider: delta.provider,
        model: delta.model,
        format: delta.format,
        display: delta.display,
        delta: delta.delta,
        startedAt: delta.startedAt,
        completedAt: delta.completedAt,
        elapsedMs: delta.elapsedMs,
        tokenCount: delta.tokenCount,
        tokenCountSource: delta.tokenCountSource,
        done: delta.done,
      });
    },
    onToolEvent: (event) => options.turns().handleToolEvent(event),
    onTurnUsage: (usage) => {
      options.store.recordUsage({
        ...usage,
        turnId: options.turns().snapshot().activeTurnId ?? undefined,
      });
    },
    onProviderSnapshot: (update) => {
      syncProviderSnapshotToSession(
        options.store,
        update,
        options.turns().snapshot().pendingApproval,
        { localProviderIds: options.localProviderIds },
      );
      if (update.path === SESSION_MIRROR_PATHS.approvals) {
        options.turns().scheduleAutoApprovals();
      }
    },
    onExternalProviderStates: (states) =>
      syncExternalProviderStatesToSession(options.store, states),
  };
}

export function createSessionEventBus(
  options: SessionRuntimeOptions,
  config: SloppyConfig,
): AgentEventBus | null {
  const logPath = process.env.SLOPPY_EVENT_LOG;
  if (!logPath) return null;
  return createAgentEventBus({
    logPath,
    actor: {
      id: options.actorId ?? options.sessionId ?? "agent",
      name: options.actorName ?? options.title,
      kind: options.actorKind ?? "agent",
      parentId: options.parentActorId,
      taskId: options.taskId,
    },
    toolEventEnrichers: createFirstPartyToolEventEnrichers(config),
  });
}
