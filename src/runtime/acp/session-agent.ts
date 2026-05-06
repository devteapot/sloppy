import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import type { ResultMessage, SlopNode } from "@slop-ai/consumer/browser";

import type {
  AgentCallbacks,
  AgentRunResult,
  AgentToolInvocation,
  ResolvedApprovalToolResult,
} from "../../core/agent";
import { LlmAbortError } from "../../llm/types";
import type { SessionAgent } from "../../session/runtime";

export type AcpAdapterConfig = {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

export type AcpSessionAgentOptions = {
  adapterId: string;
  adapter: AcpAdapterConfig;
  callbacks: AgentCallbacks;
  workspaceRoot: string;
  defaultTimeoutMs?: number;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
};

type PendingAcpApproval = {
  id: string;
  createdAt: string;
  request: acp.RequestPermissionRequest;
  invocation: AgentToolInvocation;
  response: Deferred<acp.RequestPermissionResponse>;
};

type ActivePrompt = {
  promise: Promise<acp.PromptResponse>;
  responseText: string;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 15000;

function createDeferred<T>(): Deferred<T> {
  let resolveValue!: (value: T | PromiseLike<T>) => void;
  let rejectValue!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return {
    promise,
    resolve: resolveValue,
    reject: rejectValue,
  };
}

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string | undefined, maxChars: number): string | undefined {
  if (!value || value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 16)}...[truncated]`;
}

function safeToolNameSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
}

function permissionReason(params: acp.RequestPermissionRequest): string {
  const title = params.toolCall.title ?? "ACP tool call";
  const optionNames = params.options.map((option) => option.name).filter(Boolean);
  return optionNames.length > 0
    ? `${title} requires approval (${optionNames.join(", ")}).`
    : `${title} requires approval.`;
}

function toToolStatus(status: acp.ToolCallStatus | null | undefined): "ok" | "error" {
  return status === "failed" ? "error" : "ok";
}

function selectPermissionOption(
  request: acp.RequestPermissionRequest,
  decision: "approve" | "reject" | "cancel",
): acp.RequestPermissionResponse {
  if (decision === "cancel") {
    return {
      outcome: {
        outcome: "cancelled",
      },
    };
  }

  const preferredPrefix = decision === "approve" ? "allow" : "reject";
  const option =
    request.options.find((candidate) => candidate.kind.startsWith(preferredPrefix)) ??
    (decision === "approve" ? request.options[0] : undefined);

  if (!option) {
    return {
      outcome: {
        outcome: "cancelled",
      },
    };
  }

  return {
    outcome: {
      outcome: "selected",
      optionId: option.optionId,
    },
  };
}

export class AcpSessionAgent implements SessionAgent {
  private readonly adapterId: string;
  private readonly adapter: AcpAdapterConfig;
  private readonly callbacks: AgentCallbacks;
  private readonly workspaceRoot: string;
  private readonly providerId: string;
  private readonly timeoutMs?: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private started = false;
  private stderr = "";
  private activePrompt: ActivePrompt | null = null;
  private pendingApproval: PendingAcpApproval | null = null;
  private approvalSignal = createDeferred<void>();
  private approvalCounter = 0;
  private toolInvocations = new Map<string, AgentToolInvocation>();

  constructor(options: AcpSessionAgentOptions) {
    this.adapterId = options.adapterId;
    this.adapter = options.adapter;
    this.callbacks = options.callbacks;
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.providerId = `acp:${options.adapterId}`;
    this.timeoutMs = options.adapter.timeoutMs ?? options.defaultTimeoutMs;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.adapter.command.length === 0) {
      throw new Error(`ACP adapter '${this.adapterId}' has no command configured.`);
    }

    const command = this.adapter.command[0];
    if (!command) {
      throw new Error(`ACP adapter '${this.adapterId}' has no command configured.`);
    }
    const args = this.adapter.command.slice(1);
    this.child = spawn(command, args, {
      cwd: resolve(this.adapter.cwd ?? this.workspaceRoot),
      env: {
        ...process.env,
        ...(this.adapter.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = truncate(`${this.stderr}${String(chunk)}`, 8000) ?? "";
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    const client = this.buildClient();
    this.connection = new acp.ClientSideConnection(() => client, stream);

    const exitError = new Promise<never>((_, reject) => {
      this.child?.once("exit", (code, signal) => {
        if (!this.started) {
          reject(
            new Error(
              `ACP adapter '${this.adapterId}' exited during startup (${signal ?? code ?? "unknown"}).${this.stderr ? ` stderr: ${this.stderr}` : ""}`,
            ),
          );
        }
      });
    });

    try {
      await Promise.race([this.withStartupTimeout(this.initializeSession()), exitError]);
      this.started = true;
    } catch (error) {
      this.shutdown();
      throw error;
    }
  }

  async chat(userMessage: string): Promise<AgentRunResult> {
    await this.start();
    const connection = this.requireConnection();
    const sessionId = this.requireSessionId();
    this.activePrompt = {
      responseText: "",
      promise: this.withPromptTimeout(
        connection.prompt({
          sessionId,
          prompt: [
            {
              type: "text",
              text: userMessage,
            },
          ],
        }),
      ),
    };
    return this.waitForPromptOrApproval();
  }

  async resumeWithToolResult(_result: ResolvedApprovalToolResult): Promise<AgentRunResult> {
    if (!this.activePrompt) {
      throw new Error("No ACP prompt is waiting to resume.");
    }
    return this.waitForPromptOrApproval();
  }

  async invokeProvider(): Promise<ResultMessage> {
    return {
      type: "result",
      id: crypto.randomUUID(),
      status: "error",
      error: {
        code: "unsupported",
        message: "ACP-backed session agents do not expose provider invocation.",
      },
    };
  }

  async resolveApprovalDirect(approvalId: string): Promise<ResultMessage> {
    const pending = this.takePendingApproval(approvalId);
    const response = selectPermissionOption(pending.request, "approve");
    pending.response.resolve(response);
    this.emitApprovalSnapshot(pending, "approved");
    return {
      type: "result",
      id: approvalId,
      status: "ok",
      data: response,
    };
  }

  rejectApprovalDirect(approvalId: string, reason?: string): void {
    const pending = this.takePendingApproval(approvalId);
    const decision = reason === "Turn cancelled by user." ? "cancel" : "reject";
    const response = selectPermissionOption(pending.request, decision);
    pending.response.resolve(response);
    this.emitApprovalSnapshot(pending, "rejected");
    if (decision === "cancel") {
      void this.cancelActivePrompt();
    }
  }

  cancelActiveTurn(): boolean {
    if (!this.activePrompt || !this.sessionId || !this.connection) {
      return false;
    }
    void this.cancelActivePrompt();
    return true;
  }

  clearPendingApproval(): void {
    if (!this.pendingApproval) {
      return;
    }
    const pending = this.pendingApproval;
    this.pendingApproval = null;
    pending.response.resolve({
      outcome: {
        outcome: "cancelled",
      },
    });
    this.emitApprovalSnapshot(pending, "rejected");
    void this.cancelActivePrompt();
  }

  shutdown(): void {
    void this.closeSession();
    const child = this.child;
    if (child) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        if (!child.killed || child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 1000).unref();
    }
    this.child = null;
    this.connection = null;
    this.sessionId = null;
    this.started = false;
  }

  private async initializeSession(): Promise<void> {
    const connection = this.requireConnection();
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: {
        name: "Sloppy",
        version: "0.0.0",
      },
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
      },
    });
    const session = await connection.newSession({
      cwd: resolve(this.adapter.cwd ?? this.workspaceRoot),
      mcpServers: [],
    });
    this.sessionId = session.sessionId;
  }

  private buildClient(): acp.Client {
    return {
      requestPermission: async (params) => this.handlePermissionRequest(params),
      sessionUpdate: async (params) => this.handleSessionUpdate(params),
    };
  }

  private async handlePermissionRequest(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const approvalId = `approval-${++this.approvalCounter}-${safeToolNameSegment(params.toolCall.toolCallId)}`;
    const invocation = this.invocationFromToolCall(params.toolCall);
    const pending: PendingAcpApproval = {
      id: approvalId,
      createdAt: new Date().toISOString(),
      request: params,
      invocation,
      response: createDeferred<acp.RequestPermissionResponse>(),
    };
    this.pendingApproval = pending;
    this.callbacks.onToolEvent?.({
      kind: "approval_requested",
      invocation,
      summary: this.toolSummary(params.toolCall),
      errorCode: "approval_required",
      errorMessage: permissionReason(params),
      approvalId,
    });
    this.emitApprovalSnapshot(pending, "pending");
    this.signalApprovalRequested();
    return pending.response.promise;
  }

  private async handleSessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type === "text") {
          this.appendText(update.content.text);
        }
        break;
      }
      case "tool_call": {
        const invocation = this.invocationFromToolCall(update);
        this.toolInvocations.set(update.toolCallId, invocation);
        this.callbacks.onToolEvent?.({
          kind: "started",
          invocation,
          summary: this.toolSummary(update),
        });
        if (update.status === "completed" || update.status === "failed") {
          this.callbacks.onToolEvent?.({
            kind: "completed",
            invocation,
            summary: this.toolSummary(update),
            status: toToolStatus(update.status),
            errorMessage:
              update.status === "failed"
                ? truncate(stringifyValue(update.rawOutput), 1000)
                : undefined,
          });
        }
        break;
      }
      case "tool_call_update": {
        const invocation = this.invocationFromToolCall(update);
        if (!this.toolInvocations.has(update.toolCallId)) {
          this.toolInvocations.set(update.toolCallId, invocation);
          this.callbacks.onToolEvent?.({
            kind: "started",
            invocation,
            summary: this.toolSummary(update),
          });
        }
        if (update.status === "completed" || update.status === "failed") {
          this.callbacks.onToolEvent?.({
            kind: "completed",
            invocation,
            summary: this.toolSummary(update),
            status: toToolStatus(update.status),
            errorMessage:
              update.status === "failed"
                ? truncate(stringifyValue(update.rawOutput), 1000)
                : undefined,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  private appendText(chunk: string): void {
    if (!chunk) {
      return;
    }
    if (this.activePrompt) {
      this.activePrompt.responseText += chunk;
    }
    this.callbacks.onText?.(chunk);
  }

  private invocationFromToolCall(toolCall: acp.ToolCall | acp.ToolCallUpdate): AgentToolInvocation {
    const existing = this.toolInvocations.get(toolCall.toolCallId);
    const action = toolCall.kind ?? existing?.action ?? "tool_call";
    const title = toolCall.title ?? existing?.toolName ?? action;
    const rawInput =
      "rawInput" in toolCall && toolCall.rawInput !== undefined
        ? toolCall.rawInput
        : (existing?.params.rawInput ?? {});
    const invocation: AgentToolInvocation = {
      toolUseId: toolCall.toolCallId,
      toolName: `${safeToolNameSegment(this.providerId)}__${safeToolNameSegment(action)}`,
      kind: "affordance",
      providerId: this.providerId,
      path: `/tools/${toolCall.toolCallId}`,
      action,
      params: {
        title,
        rawInput,
      },
    };
    this.toolInvocations.set(toolCall.toolCallId, invocation);
    return invocation;
  }

  private toolSummary(toolCall: acp.ToolCall | acp.ToolCallUpdate): string {
    const title = toolCall.title ?? this.toolInvocations.get(toolCall.toolCallId)?.params.title;
    return `${this.providerId}:${toolCall.kind ?? "tool"} ${title ?? toolCall.toolCallId}`;
  }

  private emitApprovalSnapshot(
    approval: PendingAcpApproval,
    status: "pending" | "approved" | "rejected",
  ): void {
    const toolCall = approval.request.toolCall;
    const rawInput = truncate(stringifyValue(toolCall.rawInput), 1200);
    const node: SlopNode = {
      id: approval.id,
      type: "item",
      properties: {
        status,
        path: `/tools/${toolCall.toolCallId}`,
        action: toolCall.kind ?? "tool_call",
        reason: permissionReason(approval.request),
        created_at: approval.createdAt,
        resolved_at: status === "pending" ? undefined : new Date().toISOString(),
        params_preview: rawInput,
        dangerous: true,
      },
      affordances: status === "pending" ? [{ action: "approve" }, { action: "reject" }] : undefined,
    };
    this.callbacks.onProviderSnapshot?.({
      providerId: this.providerId,
      path: "/approvals",
      tree: {
        id: "approvals",
        type: "collection",
        children: [node],
      },
    });
  }

  private async waitForPromptOrApproval(): Promise<AgentRunResult> {
    if (!this.activePrompt) {
      throw new Error("No active ACP prompt.");
    }
    const pendingNow = this.pendingApproval;
    if (pendingNow) {
      return {
        status: "waiting_approval",
        invocation: pendingNow.invocation,
      };
    }

    const activePrompt = this.activePrompt;
    const result = await Promise.race([
      activePrompt.promise.then((response) => ({ kind: "completed" as const, response })),
      this.approvalSignal.promise.then(() => ({ kind: "approval" as const })),
    ]);

    if (result.kind === "approval") {
      const pending = this.pendingApproval;
      if (!pending) {
        return this.waitForPromptOrApproval();
      }
      return {
        status: "waiting_approval",
        invocation: pending.invocation,
      };
    }

    this.activePrompt = null;
    this.pendingApproval = null;
    if (result.response.stopReason === "cancelled") {
      throw new LlmAbortError("ACP prompt cancelled.");
    }
    return {
      status: "completed",
      response: activePrompt.responseText,
    };
  }

  private withPromptTimeout(prompt: Promise<acp.PromptResponse>): Promise<acp.PromptResponse> {
    if (!this.timeoutMs) {
      return prompt;
    }

    let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      void this.cancelActivePrompt();
    }, this.timeoutMs);

    return prompt.finally(() => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    });
  }

  private withStartupTimeout(startup: Promise<void>): Promise<void> {
    const timeoutMs = this.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(
          new Error(
            `ACP adapter '${this.adapterId}' did not complete startup within ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
    });

    return Promise.race([startup, timeoutPromise]).finally(() => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    });
  }

  private signalApprovalRequested(): void {
    const current = this.approvalSignal;
    this.approvalSignal = createDeferred<void>();
    current.resolve();
  }

  private takePendingApproval(approvalId: string): PendingAcpApproval {
    const pending = this.pendingApproval;
    if (!pending || pending.id !== approvalId) {
      throw new Error(`Unknown ACP approval: ${approvalId}`);
    }
    this.pendingApproval = null;
    return pending;
  }

  private requireConnection(): acp.ClientSideConnection {
    if (!this.connection) {
      throw new Error(`ACP adapter '${this.adapterId}' is not connected.`);
    }
    return this.connection;
  }

  private requireSessionId(): string {
    if (!this.sessionId) {
      throw new Error(`ACP adapter '${this.adapterId}' has no active session.`);
    }
    return this.sessionId;
  }

  private async cancelActivePrompt(): Promise<void> {
    if (!this.connection || !this.sessionId) {
      return;
    }
    await this.connection.cancel({ sessionId: this.sessionId });
  }

  private async closeSession(): Promise<void> {
    if (!this.connection || !this.sessionId) {
      return;
    }
    try {
      await this.connection.closeSession?.({ sessionId: this.sessionId });
    } catch {
      // Best-effort shutdown; many ACP agents do not advertise session.close.
    }
  }
}
