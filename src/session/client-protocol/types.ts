import type { ResultMessage, SlopNode } from "@slop-ai/consumer/browser";
import type { ClientContributionManifest } from "../plugins/client-contributions";
import type { PublicSessionRecord, ScopeRecord } from "../supervisor-model";
import type { AgentSessionSnapshot, ApprovalMode, JsonObject } from "../types";
import type { SnapshotPatchOperation } from "./snapshot-patch";

export const SESSION_CLIENT_PROTOCOL = "sloppy.session-client";
export const SUPERVISOR_CLIENT_PROTOCOL = "sloppy.supervisor-client";
export const CLIENT_PROTOCOL_VERSION = 1;

export type ClientPluginSnapshot = {
  id: string;
  version: string;
  status: "active";
  description?: string;
  providerIds: string[];
  extensionNamespaces: string[];
  contributions: ClientContributionManifest;
};

export type SessionClientControls = {
  canSendMessage: boolean;
  canCancelTurn: boolean;
  canReloadConfig: boolean;
};

export type SessionClientSnapshot = {
  session: AgentSessionSnapshot;
  controls: SessionClientControls;
  pluginState: Record<string, JsonObject>;
  plugins: ClientPluginSnapshot[];
};

export type SupervisorClientSnapshot = {
  supervisor: {
    resumeSessionId: string | null;
    launchScopeKey?: string;
    launchRoot?: string;
    clientLeaseCount: number;
    autoCloseEnabled: boolean;
    scopeError?: string;
  };
  sessions: PublicSessionRecord[];
  scopes: ScopeRecord[];
};

export type ClientRequest = {
  type: "request";
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

export type ClientHello<TSnapshot> = {
  type: "hello";
  protocol: string;
  version: number;
  revision: number;
  snapshot: TSnapshot;
};

export type ClientSnapshotEvent<TSnapshot> = {
  type: "snapshot";
  revision: number;
  snapshot: TSnapshot;
};

export type ClientSnapshotPatchEvent = {
  type: "patch";
  revision: number;
  operations: SnapshotPatchOperation[];
};

export type ClientResponse =
  | { type: "response"; id: string; ok: true; result?: unknown }
  | {
      type: "response";
      id: string;
      ok: false;
      error: { code: string; message: string };
    };

export type ClientServerMessage<TSnapshot> =
  | ClientHello<TSnapshot>
  | ClientSnapshotEvent<TSnapshot>
  | ClientSnapshotPatchEvent
  | ClientResponse;

export type SaveLlmProfileInput = {
  profileId?: string;
  label?: string;
  kind?: "native" | "session-agent";
  endpointId?: string;
  model?: string;
  reasoningEffort?: string;
  thinkingEnabled?: boolean;
  thinkingDisplay?: "visible" | "hidden";
  adapterId?: string;
  apiKey?: string;
  makeDefault?: boolean;
};

export type ProviderQueryInput = {
  providerId: string;
  path: string;
  depth?: number;
  maxNodes?: number;
  window?: [number, number];
};

export type ProviderInvokeInput = {
  providerId: string;
  path: string;
  action: string;
  params?: Record<string, unknown>;
};

export type SnapshotClientApi<TSnapshot> = {
  connect(timeoutMs?: number): Promise<TSnapshot>;
  disconnect(): void;
  getSnapshot(): TSnapshot | null;
  onSnapshot(listener: (snapshot: TSnapshot) => void): () => void;
  onDisconnect(listener: (error?: Error) => void): () => void;
};

export type SupervisorCreateSessionInput = {
  workspaceId?: string;
  projectId?: string;
  title?: string;
  sessionId?: string;
  approvalMode?: ApprovalMode;
};

export type SessionClientApi = SnapshotClientApi<SessionClientSnapshot> & {
  sendMessage(text: string): Promise<unknown>;
  waitForIdle(): Promise<void>;
  cancelTurn(): Promise<unknown>;
  cancelQueuedMessage(queuedMessageId: string): Promise<unknown>;
  setApprovalMode(mode: ApprovalMode): Promise<unknown>;
  approveApproval(approvalId: string): Promise<unknown>;
  rejectApproval(approvalId: string, reason?: string): Promise<unknown>;
  cancelTask(taskId: string): Promise<unknown>;
  saveLlmProfile(input: SaveLlmProfileInput): Promise<unknown>;
  setDefaultLlmProfile(profileId: string): Promise<unknown>;
  deleteLlmProfile(profileId: string): Promise<unknown>;
  deleteLlmApiKey(profileId: string): Promise<unknown>;
  reloadConfig(): Promise<unknown>;
  invokePlugin(
    pluginId: string,
    command: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
  queryProvider(input: ProviderQueryInput): Promise<SlopNode>;
  invokeProvider(input: ProviderInvokeInput): Promise<ResultMessage>;
  loadProvider(providerId: string): Promise<unknown>;
  unloadProvider(providerId: string): Promise<unknown>;
  reloadProvider(providerId: string): Promise<unknown>;
};

export type SupervisorClientApi = SnapshotClientApi<SupervisorClientSnapshot> & {
  refreshSnapshot(): Promise<SupervisorClientSnapshot>;
  registerLease(selectedSessionId?: string, label?: string): Promise<unknown>;
  updateLease(selectedSessionId?: string, label?: string): Promise<unknown>;
  unregisterLease(): Promise<unknown>;
  createSession(input?: SupervisorCreateSessionInput): Promise<PublicSessionRecord>;
  createScopedSession(
    input: SupervisorCreateSessionInput & { workspaceId: string },
  ): Promise<PublicSessionRecord>;
  selectSession(sessionId: string): Promise<PublicSessionRecord>;
  stopSession(sessionId: string): Promise<unknown>;
  reloadConfig(): Promise<unknown>;
};
