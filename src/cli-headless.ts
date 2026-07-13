import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { SloppyConfig } from "./config/schema";
import type { LlmProfileManager } from "./llm/profile-manager";
import { InProcessSessionApi } from "./session/client-protocol";
import { type SessionAgentFactory, SessionRuntime } from "./session/runtime";
import type {
  ActivityItem,
  AgentSessionSnapshot,
  ApprovalItem,
  ApprovalMode,
  ExternalAppSnapshot,
  SessionUsageSnapshot,
  TranscriptMessage,
  TurnStateSnapshot,
} from "./session/types";

type WriteFn = (text: string) => void;

type CliHeadlessStatus = "completed" | "approval_cancelled" | "error";

type ConnectedProvider = {
  id: string;
  name: string;
};

export type CliHeadlessMetrics = {
  mode: "single";
  status: CliHeadlessStatus;
  exitCode: number;
  sessionId: string;
  turnId?: string;
  elapsedMs: number;
  promptChars: number;
  responseChars: number;
  streamed: boolean;
  toolCalls: number;
  toolResults: number;
  usage?: Record<string, unknown>;
  turn?: Record<string, unknown>;
  errorMessage?: string;
  approval?: Record<string, unknown>;
};

export type RunHeadlessSingleShotOptions = {
  prompt: string;
  config: SloppyConfig;
  metricsPath?: string;
  llmProfileManager?: LlmProfileManager;
  agentFactory?: SessionAgentFactory;
  sessionId?: string;
  approvalMode?: ApprovalMode;
  writeStdout?: WriteFn;
  writeStderr?: WriteFn;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function elapsedSince(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

function assistantText(message: TranscriptMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function pendingApprovalFrom(approvals: ApprovalItem[]): ApprovalItem | undefined {
  return approvals.find((approval) => approval.status === "pending");
}

class CliSessionRenderer {
  responseChars = 0;
  streamed = false;
  toolCalls = 0;
  toolResults = 0;

  private readonly assistantTextByMessageId = new Map<string, string>();
  private readonly printedActivityIds = new Set<string>();

  constructor(private readonly writeStdout: WriteFn) {}

  renderTranscript(messages: TranscriptMessage[]): void {
    for (const message of messages) {
      if (message.role !== "assistant") {
        continue;
      }

      const next = assistantText(message);
      const previous = this.assistantTextByMessageId.get(message.id);
      this.assistantTextByMessageId.set(message.id, next);

      if (previous === undefined) {
        if (next.length > 0) {
          this.writeStdout(next);
          this.responseChars += next.length;
          this.streamed ||= message.state === "streaming";
        }
        continue;
      }

      if (next.startsWith(previous) && next.length > previous.length) {
        const chunk = next.slice(previous.length);
        this.writeStdout(chunk);
        this.responseChars += chunk.length;
        this.streamed ||= message.state === "streaming";
      }
    }
  }

  renderActivity(items: ActivityItem[]): void {
    for (const item of items) {
      if (this.printedActivityIds.has(item.id)) {
        continue;
      }

      if (item.kind === "tool_call") {
        this.printedActivityIds.add(item.id);
        this.toolCalls += 1;
        this.writeStdout(`\n[tool] ${item.summary}\n`);
      } else if (item.kind === "tool_result") {
        this.printedActivityIds.add(item.id);
        this.toolResults += 1;
        this.writeStdout(`[result] ${item.summary}\n`);
      }
    }
  }
}

async function writeMetricsBestEffort(
  path: string | undefined,
  metrics: CliHeadlessMetrics,
  writeStderr: WriteFn,
): Promise<void> {
  if (!path) {
    return;
  }

  try {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, `${JSON.stringify(metrics, null, 2)}\n`);
  } catch (error) {
    writeStderr(`[warning] failed to write CLI metrics to ${path}: ${errorMessage(error)}\n`);
  }
}

function externalProviderIds(apps: ExternalAppSnapshot[]): string[] {
  return apps.filter((app) => app.status === "connected").map((app) => app.id);
}

function buildProviderNotice(providers: ConnectedProvider[], apps: ExternalAppSnapshot[]): string {
  const ids =
    providers.length > 0 ? providers.map((provider) => provider.id) : externalProviderIds(apps);
  if (ids.length === 0) {
    return "[sloppy] providers: (0)\n";
  }
  return `[sloppy] providers: ${ids.join(", ")} (${ids.length})\n`;
}

function buildApprovalDetails(approval: ApprovalItem | undefined, turn: TurnStateSnapshot): string {
  if (!approval) {
    return turn.message;
  }

  const target = [approval.provider, approval.action].filter(Boolean).join(":");
  const targetLine =
    target || approval.path ? `${target}${approval.path ? ` ${approval.path}` : ""}` : undefined;
  return [targetLine, approval.reason ? `reason: ${approval.reason}` : undefined]
    .filter(Boolean)
    .join("\n");
}

function metricsFrom(options: {
  status: CliHeadlessStatus;
  exitCode: number;
  sessionId: string;
  prompt: string;
  renderer: CliSessionRenderer;
  started: number;
  turn?: TurnStateSnapshot;
  usage?: SessionUsageSnapshot;
  errorText?: string;
  approval?: ApprovalItem;
  turnId?: string;
}): CliHeadlessMetrics {
  return {
    mode: "single",
    status: options.status,
    exitCode: options.exitCode,
    sessionId: options.sessionId,
    turnId: options.turnId ?? options.turn?.turnId ?? undefined,
    elapsedMs: elapsedSince(options.started),
    promptChars: options.prompt.length,
    responseChars: options.renderer.responseChars,
    streamed: options.renderer.streamed,
    toolCalls: options.renderer.toolCalls,
    toolResults: options.renderer.toolResults,
    usage: options.usage ? { ...options.usage } : undefined,
    turn: options.turn ? { ...options.turn } : undefined,
    errorMessage: options.errorText,
    approval: options.approval ? { ...options.approval } : undefined,
  };
}

export async function runHeadlessSingleShot(
  options: RunHeadlessSingleShotOptions,
): Promise<number> {
  const started = performance.now();
  const writeStdout = options.writeStdout ?? ((text) => process.stdout.write(text));
  const writeStderr = options.writeStderr ?? ((text) => process.stderr.write(text));
  const sessionId = options.sessionId ?? `cli-${crypto.randomUUID()}`;
  const renderer = new CliSessionRenderer(writeStdout);

  let runtime: SessionRuntime | null = null;
  let api: InProcessSessionApi | null = null;
  let exitCode = 1;
  let status: CliHeadlessStatus = "error";
  let errorText: string | undefined;
  let finalSnapshot: AgentSessionSnapshot | undefined;
  let approval: ApprovalItem | undefined;
  let turnId: string | undefined;

  try {
    runtime = new SessionRuntime({
      config: options.config,
      sessionId,
      title: "CLI Single Shot",
      llmProfileManager: options.llmProfileManager,
      agentFactory: options.agentFactory,
      actorId: "cli-single-shot",
      actorName: "Sloppy CLI",
      sessionPersistencePath: false,
      approvalMode: options.approvalMode,
    });
    api = new InProcessSessionApi(runtime);
    api.onSnapshot((snapshot) => {
      renderer.renderTranscript(snapshot.session.transcript);
      renderer.renderActivity(snapshot.session.activity);
    });
    const initial = await api.connect();

    writeStderr(buildProviderNotice(runtime.listConnectedProviders(), initial.session.apps));

    const send = await api.sendMessage(options.prompt);
    if (send && typeof send === "object" && "turnId" in send && typeof send.turnId === "string") {
      turnId = send.turnId;
    }

    await api.waitForIdle();
    finalSnapshot = api.getSnapshot()?.session ?? runtime.store.getSnapshot();
    renderer.renderTranscript(finalSnapshot.transcript);
    renderer.renderActivity(finalSnapshot.activity);
    const turnState = finalSnapshot.turn.state;

    if (turnState === "waiting_approval") {
      approval = pendingApprovalFrom(finalSnapshot.approvals);
      const details = buildApprovalDetails(approval, finalSnapshot.turn);
      writeStdout(
        `\n[approval] turn was cancelled — single-shot CLI cannot resolve approvals${
          details ? `\n${details}` : ""
        }\n`,
      );

      await api.cancelTurn();
      await api.waitForIdle();
      finalSnapshot = api.getSnapshot()?.session ?? runtime.store.getSnapshot();
      renderer.renderTranscript(finalSnapshot.transcript);
      renderer.renderActivity(finalSnapshot.activity);
      status = "approval_cancelled";
      exitCode = 2;
      return exitCode;
    }

    if (turnState === "error") {
      errorText = finalSnapshot.turn.lastError ?? finalSnapshot.turn.message;
      if (errorText) {
        writeStderr(`[error] ${errorText}\n`);
      }
      status = "error";
      exitCode = 1;
      return exitCode;
    }

    writeStdout("\n");
    status = "completed";
    exitCode = 0;
    return exitCode;
  } catch (error) {
    errorText = errorMessage(error);
    writeStderr(`[error] ${errorText}\n`);
    exitCode = 1;
    status = "error";
    return exitCode;
  } finally {
    finalSnapshot ??= api?.getSnapshot()?.session;
    const metrics = metricsFrom({
      status,
      exitCode,
      sessionId,
      prompt: options.prompt,
      renderer,
      started,
      turn: finalSnapshot?.turn,
      usage: finalSnapshot?.usage,
      errorText,
      approval,
      turnId,
    });

    try {
      api?.disconnect();
    } catch {
      // best-effort cleanup
    }
    try {
      runtime?.shutdown();
    } catch {
      // best-effort cleanup
    }

    await writeMetricsBestEffort(options.metricsPath, metrics, writeStderr);
  }
}
