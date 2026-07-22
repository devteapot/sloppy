import type { LlmTool } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../../config/schema";
import type { ToolResultContentBlock, ToolUseContentBlock } from "../../llm/types";
import type { ProviderRuntimeHub } from "../hub";
import type { ImageRegistry } from "../images";
import type { ToolPolicyDecision } from "../role";
import type { RuntimeToolResolution, RuntimeToolSet } from "../tools";

export interface RunLoopHooks {
  toolPolicy?: (
    resolution: RuntimeToolResolution,
    params: Record<string, unknown>,
    config: SloppyConfig,
  ) => ToolPolicyDecision;
  transformInvoke?: (
    resolution: RuntimeToolResolution,
    params: Record<string, unknown>,
    config: SloppyConfig,
  ) => Record<string, unknown>;
  beforeNextTurn?: (hub: ProviderRuntimeHub, signal?: AbortSignal) => Promise<void>;
  /** Runtime role id forwarded as per-invocation Hub policy metadata. */
  roleId?: string;
  /** Session-owned controls; reusable capabilities remain providers or skills. */
  localTools?: () => LocalRuntimeTool[];
}

export type ToolResult = {
  block: ToolResultContentBlock;
  summary: string;
};

export type AgentToolResult = {
  kind?: string;
  data?: unknown;
};

export type LocalRuntimeToolResult = {
  status: "ok" | "error";
  summary: string;
  content: unknown;
  isError?: boolean;
};

export type LocalRuntimeToolContext = {
  hub: ProviderRuntimeHub;
  config: SloppyConfig;
  signal?: AbortSignal;
};

export type LocalRuntimeTool = {
  pluginId?: string;
  tool: LlmTool;
  providerId?: string;
  path?: string;
  execute: (
    params: Record<string, unknown>,
    context: LocalRuntimeToolContext,
  ) => LocalRuntimeToolResult | Promise<LocalRuntimeToolResult>;
};

export type AgentToolInvocation = {
  toolUseId: string;
  toolName: string;
  kind: "observation" | "affordance" | "local";
  pluginId?: string;
  providerId?: string;
  path?: string;
  action: string;
  label?: string;
  resultKind?: string;
  params: Record<string, unknown>;
};

export type AgentToolEvent =
  | {
      kind: "started";
      invocation: AgentToolInvocation;
      summary: string;
    }
  | {
      kind: "completed";
      invocation: AgentToolInvocation;
      summary: string;
      status: "ok" | "error" | "accepted" | "cancelled";
      taskId?: string;
      errorCode?: string;
      errorMessage?: string;
      result?: AgentToolResult;
    }
  | {
      kind: "approval_requested";
      invocation: AgentToolInvocation;
      summary: string;
      errorCode: string;
      errorMessage: string;
      approvalId?: string;
    };

export type PendingApprovalContinuation = {
  blockedInvocation: AgentToolInvocation;
  iteration: number;
  toolCalls: ToolUseContentBlock[];
  nextToolCallIndex: number;
  toolResults: ToolResultContentBlock[];
  deferredToolResults?: {
    toolCallIndex: number;
    result: ToolResultContentBlock;
  }[];
};

export type RunLoopResult =
  | {
      status: "completed";
      response: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        thinkingTokens?: number;
      };
    }
  | {
      status: "waiting_approval";
      pending: PendingApprovalContinuation;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        thinkingTokens?: number;
      };
    };

export type ExecuteToolCallResult =
  | {
      kind: "completed";
      invocation?: AgentToolInvocation;
      result: ToolResult;
      status: "ok" | "error" | "accepted";
      taskId?: string;
      errorCode?: string;
      errorMessage?: string;
      activityResult?: AgentToolResult;
    }
  | {
      kind: "approval_requested";
      invocation: AgentToolInvocation;
      summary: string;
      errorCode: string;
      errorMessage: string;
      approvalId?: string;
    };

export type ExecuteToolCallsOptions = {
  toolCalls: ToolUseContentBlock[];
  startIndex: number;
  toolResults: ToolResultContentBlock[];
  iteration: number;
  toolSet: RuntimeToolSet;
  localTools: LocalRuntimeTool[];
  hub: ProviderRuntimeHub;
  config: SloppyConfig;
  onToolCall?: (summary: string) => void;
  onToolResult?: (summary: string) => void;
  onToolEvent?: (event: AgentToolEvent) => void;
  toolPolicy?: RunLoopHooks["toolPolicy"];
  transformInvoke?: RunLoopHooks["transformInvoke"];
  roleId?: string;
  signal?: AbortSignal;
  imageRegistry?: ImageRegistry;
};
