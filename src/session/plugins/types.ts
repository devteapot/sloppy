import type { ResultMessage, SlopNode } from "@slop-ai/consumer/browser";
import type { NodeDescriptor } from "@slop-ai/server";

import type { SloppyConfig } from "../../config/schema";
import type { AgentRunResult, LocalRuntimeTool } from "../../core/agent";
import type { SessionStore } from "../store";
import type { SessionSnapshotMigrator, SessionSnapshotRecoverer } from "../store/persistence";
import type { AgentSessionSnapshot, QueuedSessionMessage, SessionStoreEventType } from "../types";
import type { UiContributionManifest } from "./ui-contributions";

export type PluginTurnRequest = {
  pluginId: string;
  runId: string;
  text: string;
  author: string;
  role?: "user" | "assistant" | "system";
  continuation?: boolean;
  metadata?: Record<string, unknown>;
};

export type ActivePluginTurn = {
  pluginId: string;
  runId: string;
  author: string;
  continuation: boolean;
  metadata?: Record<string, unknown>;
};

export type PluginTurnCompleteEvent = {
  turnId: string;
  pluginTurn: ActivePluginTurn;
  result: AgentRunResult;
  elapsedMs: number;
  usedTools: boolean;
};

export type PluginTurnFailureEvent = {
  turnId: string;
  pluginTurn: ActivePluginTurn;
  message: string;
  cancelled: boolean;
};

export type PluginRuntimeContext = {
  config: () => SloppyConfig;
  store: SessionStore;
  snapshot: () => AgentSessionSnapshot;
  ensureReady: () => Promise<void>;
  invokeProvider: (
    providerId: string,
    path: string,
    action: string,
    params?: Record<string, unknown>,
  ) => Promise<ResultMessage>;
  queryProvider: (
    providerId: string,
    path: string,
    options?: {
      depth?: number;
      maxNodes?: number;
      window?: [number, number];
    },
  ) => Promise<SlopNode>;
  startTurn: (request: PluginTurnRequest) => { status: "started"; turnId: string };
  queueTurn: (request: PluginTurnRequest) => {
    status: "queued";
    queuedMessageId: string;
    position: number;
  };
  drainQueue: () => void;
  audit: (event: Record<string, unknown> & { kind: string }) => void;
};

export type SessionNodeContribution = {
  path: string;
  build: (ctx: PluginRuntimeContext) => NodeDescriptor;
};

export type SessionSummaryContribution = {
  props?: Record<string, unknown>;
  summary?: string;
};

export type SessionRuntimePlugin = {
  id: string;
  version: string;
  description?: string;
  defaultEnabled?: boolean;
  providerIds?: string[];
  extensionNamespaces?: string[];
  extensionEvents?: Record<string, readonly SessionStoreEventType[]>;
  sessionNodes?: (ctx: PluginRuntimeContext) => SessionNodeContribution[];
  migrateSnapshot?: SessionSnapshotMigrator;
  recoverSnapshot?: SessionSnapshotRecoverer;
  onStartup?: (ctx: PluginRuntimeContext) => void | Promise<void>;
  onShutdown?: (ctx: PluginRuntimeContext) => void;
  localTools?: (
    ctx: PluginRuntimeContext,
    activeTurn: ActivePluginTurn | null,
  ) => LocalRuntimeTool[];
  acceptQueuedTurn?: (
    message: QueuedSessionMessage,
    ctx: PluginRuntimeContext,
  ) => PluginTurnRequest | null;
  nextTurn?: (ctx: PluginRuntimeContext) => PluginTurnRequest | null;
  onTurnComplete?: (event: PluginTurnCompleteEvent, ctx: PluginRuntimeContext) => void;
  onTurnFailure?: (event: PluginTurnFailureEvent, ctx: PluginRuntimeContext) => void;
  sessionSummary?: (ctx: PluginRuntimeContext) => SessionSummaryContribution | null;
  ui?: UiContributionManifest;
};
