import type { KeyEvent } from "@opentui/core";

import type { SupervisorSessionItem } from "../slop/supervisor-client";
import type {
  ActivityItem,
  AppItem,
  ApprovalItem,
  GoalState,
  SessionViewSnapshot,
  TaskItem,
} from "../slop/types";

export function formatActivityLine(item: ActivityItem): string {
  const target = [item.provider, item.action, item.path].filter(Boolean).join(" ");
  const tool = item.toolUseId ? ` · tool=${item.toolUseId}` : "";
  return `${item.status} ${item.kind}${target ? ` · ${target}` : ""}${tool} · ${item.summary}`;
}

export function formatApprovalLine(item: ApprovalItem): string {
  return `${item.status} ${item.provider}.${item.action} ${item.path} · ${item.reason}`;
}

export function formatTaskLine(item: TaskItem): string {
  const progress = item.progress === undefined ? "" : ` ${(item.progress * 100).toFixed(0)}%`;
  const activity = item.linkedActivityId ? ` · activity=${item.linkedActivityId}` : "";
  return `${item.status}${progress} ${item.provider}:${item.providerTaskId}${activity} · ${item.message}`;
}

export function formatAppLine(item: AppItem): string {
  return `${item.status} ${item.name} · ${item.transport}`;
}

export function formatSupervisorSessionLine(item: SupervisorSessionItem): string {
  const scope =
    item.workspaceId && item.projectId
      ? `${item.workspaceId}/${item.projectId}`
      : (item.workspaceId ?? item.workspaceRoot ?? "unscoped");
  const selected = item.selected ? "active" : "idle";
  const goal =
    item.goalStatus && item.goalStatus !== "none"
      ? ` · goal=${item.goalStatus} tokens=${item.goalTotalTokens}`
      : "";
  const pressure =
    item.queuedCount > 0 || item.pendingApprovalCount > 0 || item.runningTaskCount > 0
      ? ` · queue=${item.queuedCount} approvals=${item.pendingApprovalCount} tasks=${item.runningTaskCount}`
      : "";
  return `${selected} ${item.title ?? item.id} · ${scope} · turn=${item.turnState ?? "unknown"}${goal}${pressure}`;
}

export function formatGoalLine(goal: GoalState): string {
  if (!goal.exists) {
    return "no goal";
  }
  const budget = goal.tokenBudget ? `/${goal.tokenBudget}` : "";
  const elapsedSeconds = Math.round(goal.elapsedMs / 1000);
  return `${goal.status} · tokens=${goal.totalTokens}${budget} · ${elapsedSeconds}s · ${goal.objective ?? ""}`;
}

export function firstPendingApproval(snapshot: SessionViewSnapshot): ApprovalItem | undefined {
  return snapshot.approvals.find((approval) => approval.status === "pending");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isControlKey(key: KeyEvent, name: string, codePoint: number): boolean {
  const normalizedName = key.name.toLowerCase();
  if (key.ctrl && normalizedName === name) {
    return true;
  }
  return key.sequence.charCodeAt(0) === codePoint || key.raw.charCodeAt(0) === codePoint;
}

export function isPrintableSequence(sequence: string): boolean {
  if (sequence.length === 0) return false;
  for (const char of sequence) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) {
      return false;
    }
  }
  return true;
}

export function formatModelLabel(snapshot: SessionViewSnapshot): string {
  const s = snapshot.session;
  const l = snapshot.llm;
  return (
    [l.selectedProvider ?? s.modelProvider, l.selectedModel ?? s.model].filter(Boolean).join("/") ||
    "no model"
  );
}

export function formatUsageLine(snapshot: SessionViewSnapshot): string {
  const u = snapshot.usage;
  if (!u) return "";
  const segments: string[] = [];
  if (u.lastModelCallInputSource === "reported" || u.lastModelCallOutputSource === "reported") {
    segments.push(
      `last ${formatMaybeTokens(u.lastModelCallInputTokens)} in/${formatMaybeTokens(
        u.lastModelCallOutputTokens,
      )} out`,
    );
  } else if (u.currentTurnModelCalls > 0) {
    segments.push("last N/A in/N/A out");
  }
  if (
    u.lastStateContextTokens !== undefined &&
    (u.lastStateContextTokenSource === "provider" || u.lastStateContextTokenSource === "local")
  ) {
    segments.push(`state tail ${formatTokens(u.lastStateContextTokens)}`);
  } else if (u.currentTurnModelCalls > 0) {
    segments.push("state tail N/A");
  }
  if (u.modelContextWindowTokens !== undefined) {
    if (u.availableContextTokens === undefined) {
      segments.push(`window ${formatTokens(u.modelContextWindowTokens)}`);
    } else {
      const consumed = Math.max(0, u.modelContextWindowTokens - u.availableContextTokens);
      segments.push(`ctx ${formatTokens(consumed)}/${formatTokens(u.modelContextWindowTokens)}`);
    }
  }
  return segments.join(" · ");
}

function formatMaybeTokens(n: number | undefined): string {
  return n === undefined ? "N/A" : formatTokens(n);
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const value = n / 1_000_000;
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M`;
}

export function composerHint(snapshot: SessionViewSnapshot, queued: number): string {
  if (!snapshot.composer.canSend) {
    return snapshot.composer.disabledReason ?? "Composer disabled.";
  }

  const model = formatModelLabel(snapshot);
  const modelSuffix = ` · ${model}`;

  const pendingApproval = snapshot.approvals.some((a) => a.status === "pending");
  if (pendingApproval) {
    return `Approval pending — resolve it first; new messages will queue. queued=${queued}${modelSuffix}`;
  }

  if (snapshot.turn.state === "running" || snapshot.turn.state === "waiting_approval") {
    return `Turn ${snapshot.turn.state}; new messages append to the session queue. queued=${queued}${modelSuffix}`;
  }

  return queued > 0 ? `Ready. queued=${queued}${modelSuffix}` : `Ready.${modelSuffix}`;
}

export function commandHelp(): string {
  return "/setup /approvals /tasks /apps /inspect · /goal <objective>|pause|resume|complete|clear · /verbosity [compact|normal|verbose] · /query [app-id:]path depth · /invoke [app-id:]path action {json} · /profile provider model · /profile-secret provider model · /queue-cancel <id|pos> · /mouse [on|off] · /clear · /quit";
}
