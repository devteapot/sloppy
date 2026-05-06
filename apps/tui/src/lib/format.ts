import type { KeyEvent } from "@opentui/core";

import type {
  ActivityItem,
  AppItem,
  ApprovalItem,
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

export function firstPendingApproval(snapshot: SessionViewSnapshot): ApprovalItem | undefined {
  return snapshot.approvals.find((approval) => approval.status === "pending");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isPrintableSequence(sequence: string): boolean {
  if (sequence.length === 0) {
    return false;
  }
  for (let index = 0; index < sequence.length; index += 1) {
    const code = sequence.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

export function isControlKey(key: KeyEvent, name: string, codePoint: number): boolean {
  const normalizedName = key.name.toLowerCase();
  if (key.ctrl && normalizedName === name) {
    return true;
  }
  return key.sequence.charCodeAt(0) === codePoint || key.raw.charCodeAt(0) === codePoint;
}

export function composerHint(snapshot: SessionViewSnapshot, queued: number): string {
  if (!snapshot.composer.canSend) {
    return snapshot.composer.disabledReason ?? "Composer disabled.";
  }

  const pendingApproval = snapshot.approvals.some((a) => a.status === "pending");
  if (pendingApproval) {
    return `Approval pending — resolve it first; new messages will queue. queued=${queued}`;
  }

  if (snapshot.turn.state === "running" || snapshot.turn.state === "waiting_approval") {
    return `Turn ${snapshot.turn.state}; new messages append to the session queue. queued=${queued}`;
  }

  return queued > 0 ? `Ready. queued=${queued}` : "Ready.";
}

export function commandHelp(): string {
  return "/setup /approvals /tasks /apps /inspect /settings · /mouse [on|off|toggle] (F7) · /query [app-id:]path depth --window 0:20 --max-nodes 100 · /invoke [app-id:]path action {json} · /profile provider model --reasoning-effort high --adapter id --base-url url · /profile-secret provider model · /default profile";
}
