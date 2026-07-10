import type { ResultMessage, SlopNode } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../config/schema";
import type { AgentCallbacks, AgentRunResult, ResolvedApprovalToolResult } from "../core/agent";
import type { ConversationHistory } from "../core/history";
import type { LlmProfileManager } from "../llm/profile-manager";
import type { RuntimeServiceKey } from "../runtime/services";

export interface SessionAgent {
  start(): Promise<void>;
  listConnectedProviders?(): { id: string; name: string }[];
  getRuntimeService?<T>(key: RuntimeServiceKey<T>): T | undefined;
  chat(userMessage: string): Promise<AgentRunResult>;
  resumeWithToolResult(result: ResolvedApprovalToolResult): Promise<AgentRunResult>;
  invokeProvider(
    providerId: string,
    path: string,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<ResultMessage>;
  queryProvider?(
    providerId: string,
    path: string,
    options?: { depth?: number; maxNodes?: number; window?: [number, number] },
  ): Promise<SlopNode>;
  loadProvider?(providerId: string): Promise<boolean>;
  reloadProvider?(providerId: string): Promise<void>;
  unloadProvider?(providerId: string): boolean;
  resolveApprovalDirect(approvalId: string): Promise<ResultMessage>;
  rejectApprovalDirect(approvalId: string, reason?: string): void;
  cancelActiveTurn(): boolean;
  clearPendingApproval(): void;
  updateConfig?(config: SloppyConfig, options?: { syncLlmProfileManager?: boolean }): void;
  shutdown(): void;
  waitForShutdown?(): Promise<void>;
  isShutdownComplete?(): boolean;
  shutdownAsync?(): Promise<void>;
}

export type SessionAgentFactory = (
  callbacks: AgentCallbacks,
  config: SloppyConfig,
  llmProfileManager: LlmProfileManager,
  conversationHistory?: ConversationHistory,
) => SessionAgent;

export type SendMessageResult =
  | { status: "started"; turnId: string }
  | { status: "queued"; queuedMessageId: string; position: number };
