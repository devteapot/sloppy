import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { SlopConsumer, type SlopNode } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "./config/schema";
import type { LlmProfileManager } from "./llm/profile-manager";
import { InProcessTransport } from "./providers/in-process";
import { AgentSessionProvider } from "./session/provider";
import { type SessionAgentFactory, SessionRuntime } from "./session/runtime";

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
  providerId: string;
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
  providerId?: string;
  writeStdout?: WriteFn;
  writeStderr?: WriteFn;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function elapsedSince(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

function stringProp(node: SlopNode, key: string): string | undefined {
  const value = node.properties?.[key];
  return typeof value === "string" ? value : undefined;
}

function nodeSummary(node: SlopNode): string {
  return node.meta?.summary ?? stringProp(node, "summary") ?? node.id;
}

function assistantText(message: SlopNode): string {
  let text = "";
  for (const group of message.children ?? []) {
    for (const block of group.children ?? []) {
      text += stringProp(block, "text") ?? "";
    }
  }
  return text;
}

function pendingApprovalFrom(approvals: SlopNode): SlopNode | undefined {
  return approvals.children?.find((child) => child.properties?.status === "pending");
}

class CliSessionRenderer {
  responseChars = 0;
  streamed = false;
  toolCalls = 0;
  toolResults = 0;

  private readonly assistantTextByMessageId = new Map<string, string>();
  private readonly printedActivityIds = new Set<string>();

  constructor(private readonly writeStdout: WriteFn) {}

  renderTranscript(tree: SlopNode | null): void {
    for (const message of tree?.children ?? []) {
      if (message.properties?.role !== "assistant") {
        continue;
      }

      const next = assistantText(message);
      const previous = this.assistantTextByMessageId.get(message.id);
      this.assistantTextByMessageId.set(message.id, next);

      if (previous === undefined) {
        if (next.length > 0) {
          this.writeStdout(next);
          this.responseChars += next.length;
          this.streamed ||= message.properties?.state === "streaming";
        }
        continue;
      }

      if (next.startsWith(previous) && next.length > previous.length) {
        const chunk = next.slice(previous.length);
        this.writeStdout(chunk);
        this.responseChars += chunk.length;
        this.streamed ||= message.properties?.state === "streaming";
      }
    }
  }

  renderActivity(tree: SlopNode | null): void {
    for (const item of tree?.children ?? []) {
      if (this.printedActivityIds.has(item.id)) {
        continue;
      }

      const kind = item.properties?.kind;
      if (kind === "tool_call") {
        this.printedActivityIds.add(item.id);
        this.toolCalls += 1;
        this.writeStdout(`\n[tool] ${nodeSummary(item)}\n`);
      } else if (kind === "tool_result") {
        this.printedActivityIds.add(item.id);
        this.toolResults += 1;
        this.writeStdout(`[result] ${nodeSummary(item)}\n`);
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

async function safeQuery(
  consumer: SlopConsumer | null,
  path: string,
  depth: number,
): Promise<SlopNode | null> {
  if (!consumer) {
    return null;
  }

  try {
    return await consumer.query(path, depth);
  } catch {
    return null;
  }
}

function externalProviderIds(apps: SlopNode | null): string[] {
  return (apps?.children ?? [])
    .filter((app) => (stringProp(app, "status") ?? "connected") === "connected")
    .map((app) => stringProp(app, "provider_id") ?? app.id)
    .filter((id) => id.length > 0);
}

function buildProviderNotice(providers: ConnectedProvider[], apps: SlopNode | null): string {
  const ids =
    providers.length > 0 ? providers.map((provider) => provider.id) : externalProviderIds(apps);
  if (ids.length === 0) {
    return "[sloppy] providers: (0)\n";
  }
  return `[sloppy] providers: ${ids.join(", ")} (${ids.length})\n`;
}

function buildApprovalDetails(approval: SlopNode | undefined, turn: SlopNode | null): string {
  if (!approval) {
    return turn ? (stringProp(turn, "message") ?? "") : "";
  }

  const provider = stringProp(approval, "provider");
  const action = stringProp(approval, "action");
  const path = stringProp(approval, "path");
  const reason = nodeSummary(approval);
  const target = [provider, action].filter(Boolean).join(":");
  const targetLine = target || path ? `${target}${path ? ` ${path}` : ""}` : undefined;
  return [targetLine, reason ? `reason: ${reason}` : undefined].filter(Boolean).join("\n");
}

function metricsFrom(options: {
  status: CliHeadlessStatus;
  exitCode: number;
  sessionId: string;
  providerId: string;
  prompt: string;
  renderer: CliSessionRenderer;
  started: number;
  turn: SlopNode | null;
  usage: SlopNode | null;
  errorText?: string;
  approval?: SlopNode;
  turnId?: string;
}): CliHeadlessMetrics {
  return {
    mode: "single",
    status: options.status,
    exitCode: options.exitCode,
    sessionId: options.sessionId,
    providerId: options.providerId,
    turnId: options.turnId ?? (options.turn ? stringProp(options.turn, "turn_id") : undefined),
    elapsedMs: elapsedSince(options.started),
    promptChars: options.prompt.length,
    responseChars: options.renderer.responseChars,
    streamed: options.renderer.streamed,
    toolCalls: options.renderer.toolCalls,
    toolResults: options.renderer.toolResults,
    usage: options.usage?.properties,
    turn: options.turn?.properties,
    errorMessage: options.errorText,
    approval: options.approval?.properties,
  };
}

export async function runHeadlessSingleShot(
  options: RunHeadlessSingleShotOptions,
): Promise<number> {
  const started = performance.now();
  const writeStdout = options.writeStdout ?? ((text) => process.stdout.write(text));
  const writeStderr = options.writeStderr ?? ((text) => process.stderr.write(text));
  const sessionId = options.sessionId ?? `cli-${crypto.randomUUID()}`;
  const providerId = options.providerId ?? `sloppy-session-${sessionId}`;
  const renderer = new CliSessionRenderer(writeStdout);

  let runtime: SessionRuntime | null = null;
  let provider: AgentSessionProvider | null = null;
  let consumer: SlopConsumer | null = null;
  let transcriptSubscriptionId: string | null = null;
  let activitySubscriptionId: string | null = null;
  let exitCode = 1;
  let status: CliHeadlessStatus = "error";
  let errorText: string | undefined;
  let finalTurn: SlopNode | null = null;
  let finalUsage: SlopNode | null = null;
  let approval: SlopNode | undefined;
  let turnId: string | undefined;

  try {
    runtime = new SessionRuntime({
      config: options.config,
      sessionId,
      title: "CLI Single Shot",
      ignoredProviderIds: [providerId],
      llmProfileManager: options.llmProfileManager,
      agentFactory: options.agentFactory,
      actorId: "cli-single-shot",
      actorName: "Sloppy CLI",
      sessionPersistencePath: false,
    });
    provider = new AgentSessionProvider(runtime, {
      providerId,
      providerName: "Sloppy CLI Session",
    });
    consumer = new SlopConsumer(new InProcessTransport(provider.server));

    await runtime.start();
    await consumer.connect();

    const [transcript, activity] = await Promise.all([
      consumer.subscribe("/transcript", 5),
      consumer.subscribe("/activity", 2),
    ]);
    transcriptSubscriptionId = transcript.id;
    activitySubscriptionId = activity.id;
    renderer.renderTranscript(transcript.snapshot);
    renderer.renderActivity(activity.snapshot);

    consumer.on("patch", (subscriptionId: string) => {
      if (subscriptionId === transcriptSubscriptionId) {
        renderer.renderTranscript(consumer?.getTree(subscriptionId) ?? null);
      } else if (subscriptionId === activitySubscriptionId) {
        renderer.renderActivity(consumer?.getTree(subscriptionId) ?? null);
      }
    });

    writeStderr(
      buildProviderNotice(runtime.listConnectedProviders(), await consumer.query("/apps", 1)),
    );

    const send = await consumer.invoke("/composer", "send_message", { text: options.prompt });
    if (send.status !== "ok") {
      throw new Error(send.error?.message ?? "Failed to submit CLI message.");
    }
    if (send.data && typeof send.data === "object") {
      const data = send.data as Record<string, unknown>;
      const reportedTurnId = data.turnId ?? data.turn_id;
      if (typeof reportedTurnId === "string") {
        turnId = reportedTurnId;
      }
    }

    await runtime.waitForIdle();
    renderer.renderTranscript(await consumer.query("/transcript", 5));
    renderer.renderActivity(await consumer.query("/activity", 2));

    finalTurn = await consumer.query("/turn", 1);
    finalUsage = await consumer.query("/usage", 1);
    const turnState = stringProp(finalTurn, "state");

    if (turnState === "waiting_approval") {
      const approvals = await consumer.query("/approvals", 2);
      approval = pendingApprovalFrom(approvals);
      const details = buildApprovalDetails(approval, finalTurn);
      writeStdout(
        `\n[approval] turn was cancelled — single-shot CLI cannot resolve approvals${
          details ? `\n${details}` : ""
        }\n`,
      );

      const cancel = await consumer.invoke("/turn", "cancel_turn", {});
      if (cancel.status !== "ok") {
        throw new Error(cancel.error?.message ?? "Failed to cancel approval-gated turn.");
      }
      await runtime.waitForIdle();
      renderer.renderTranscript(await consumer.query("/transcript", 5));
      renderer.renderActivity(await consumer.query("/activity", 2));
      finalTurn = await consumer.query("/turn", 1);
      finalUsage = await consumer.query("/usage", 1);
      status = "approval_cancelled";
      exitCode = 2;
      return exitCode;
    }

    if (turnState === "error") {
      errorText = stringProp(finalTurn, "last_error") ?? stringProp(finalTurn, "message");
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
    finalTurn ??= await safeQuery(consumer, "/turn", 1);
    finalUsage ??= await safeQuery(consumer, "/usage", 1);
    const metrics = metricsFrom({
      status,
      exitCode,
      sessionId,
      providerId,
      prompt: options.prompt,
      renderer,
      started,
      turn: finalTurn,
      usage: finalUsage,
      errorText,
      approval,
      turnId,
    });

    try {
      consumer?.disconnect();
    } catch {
      // best-effort cleanup
    }
    try {
      provider?.stop();
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
