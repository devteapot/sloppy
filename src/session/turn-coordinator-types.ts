import type { ResultMessage } from "@slop-ai/consumer/browser";

import type { AgentRunResult, ResolvedApprovalToolResult } from "../core/agent";
import type { ToolResultContentBlock } from "../llm/types";
import type { PendingApprovalMirror } from "./mirror-sync";
import type { SessionPluginManager } from "./plugins";
import type { ActivePluginTurn, PluginTurnRequest } from "./plugins/types";
import type { SessionStore } from "./store";
import type { ToolCallResult } from "./types";

export type TurnSubmission =
  | { source: "user"; text: string }
  | { source: "plugin"; request: PluginTurnRequest };

export type TurnSubmissionResult =
  | { status: "started"; turnId: string }
  | { status: "queued"; queuedMessageId: string; position: number };

export type ApprovalResolutionResult = { approvalId: string; status: string };

export type TurnCancelResult = { status: string; turnId: string };

export type TurnCoordinatorSnapshot = {
  activeTurnId: string | null;
  activePluginTurn: ActivePluginTurn | null;
  pendingApproval: PendingApprovalMirror | null;
  canCancel: boolean;
  hasActiveRun: boolean;
};

export interface TurnAgentPort {
  chat(userMessage: string): Promise<AgentRunResult>;
  resumeWithToolResult(result: ResolvedApprovalToolResult): Promise<AgentRunResult>;
  invokeProvider(
    providerId: string,
    path: string,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<ResultMessage>;
  resolveApprovalDirect(approvalId: string): Promise<ResultMessage>;
  rejectApprovalDirect(approvalId: string, reason?: string): void;
  cancelActiveTurn(): boolean;
  clearPendingApproval(): void;
}

export type TurnCoordinatorDeps = {
  store: SessionStore;
  plugins: SessionPluginManager;
  agent: () => TurnAgentPort;
  audit: (event: Record<string, unknown> & { kind: string }) => void;
  previewToolParams: (action: string, params: Record<string, unknown>) => string | undefined;
  boundToolResult: (
    input: { kind?: string; data?: unknown } | undefined,
  ) => ToolCallResult | undefined;
  buildToolResultBlock: (toolUseId: string, result: ResultMessage) => ToolResultContentBlock;
  isAbortError: (error: unknown) => boolean;
};
