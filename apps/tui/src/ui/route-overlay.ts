import { Text } from "@earendil-works/pi-tui";

import type { SessionViewSnapshot, TuiRoute } from "../backend/slop-types";
import type { SupervisorSnapshot } from "../backend/supervisor-client";
import { projectIndicators } from "../state/manifest-projection";
import { buildSlashEntries } from "../state/slash-catalog";
import { sanitizeTerminalText } from "./render-safety";

function line(value: string | undefined): string {
  return value && value.length > 0 ? value : "-";
}

function renderApprovals(snapshot: SessionViewSnapshot): string {
  if (snapshot.approvals.length === 0) return "No approvals.";
  return snapshot.approvals
    .map((item) => `${item.id} ${item.status} ${item.provider}.${item.action}\n  ${item.reason}`)
    .join("\n\n");
}

function renderTasks(snapshot: SessionViewSnapshot): string {
  if (snapshot.tasks.length === 0) return "No tasks.";
  return snapshot.tasks
    .map((item) => `${item.id} ${item.status} ${item.providerTaskId}\n  ${item.message}`)
    .join("\n\n");
}

function renderApps(snapshot: SessionViewSnapshot): string {
  if (snapshot.apps.length === 0) return "No attached apps.";
  return snapshot.apps
    .map(
      (item) =>
        `${item.id} ${item.status} ${item.transport}${item.lastError ? `\n  ${item.lastError}` : ""}`,
    )
    .join("\n\n");
}

function renderSetup(snapshot: SessionViewSnapshot): string {
  const profiles = snapshot.llm.profiles
    .map((profile) => {
      const thinking = profile.thinkingEffectiveReason
        ? ` thinking=${profile.thinkingEffectiveEnabled ? "on" : "off"}/${profile.thinkingDisplay ?? "visible"}/${profile.thinkingEffort ?? "-"}`
        : "";
      return `${profile.id}${profile.isDefault ? " *" : ""} ${profile.provider}/${profile.model} ${profile.ready ? "ready" : "not ready"}${thinking}`;
    })
    .join("\n");
  return [
    `LLM: ${snapshot.llm.status}`,
    line(snapshot.llm.message),
    "",
    profiles || "No profiles.",
  ].join("\n");
}

function renderRuntime(
  snapshot: SessionViewSnapshot,
  supervisor: SupervisorSnapshot | null,
): string {
  const indicators = projectIndicators(snapshot)
    .map((indicator) => indicator.text)
    .join("\n");
  const sessions = (supervisor?.sessions ?? [])
    .map(
      (session) =>
        `${session.isResumeSession ? "*" : " "} ${session.id} ${session.runtimeStatus} ${session.title ?? ""}`,
    )
    .join("\n");
  return [
    indicators || "No active UI indicators.",
    "",
    sessions ? `Sessions\n${sessions}` : "No supervisor attached.",
  ].join("\n");
}

function renderInspect(snapshot: SessionViewSnapshot): string {
  const result =
    snapshot.inspect.result?.status === "error"
      ? snapshot.inspect.result.error?.message
      : JSON.stringify(snapshot.inspect.tree ?? {}, null, 2);
  return [`${snapshot.inspect.targetName} ${snapshot.inspect.path}`, result ?? ""].join("\n\n");
}

function renderHelp(snapshot: SessionViewSnapshot): string {
  const commands = buildSlashEntries(snapshot.plugins, { actionsByPath: snapshot.actionsByPath })
    .map((entry) => {
      const aliases = entry.aliases?.length ? ` (${entry.aliases.join(", ")})` : "";
      const signature = entry.signature ? ` ${entry.signature}` : "";
      return `/${entry.name}${signature}${aliases}\n  ${entry.description}`;
    })
    .join("\n\n");
  return [
    "Keys",
    "  Ctrl+K  command palette",
    "  Ctrl+O  expand/collapse Thinking output",
    "  Esc     close overlay, clear slash draft, or cancel active turn",
    "  Ctrl+C  exit",
    "",
    "Slash commands",
    commands,
  ].join("\n");
}

export function routeOverlayText(
  route: TuiRoute,
  snapshot: SessionViewSnapshot,
  supervisor: SupervisorSnapshot | null,
): string {
  if (route === "approvals") return sanitizeTerminalText(renderApprovals(snapshot));
  if (route === "tasks") return sanitizeTerminalText(renderTasks(snapshot));
  if (route === "apps") return sanitizeTerminalText(renderApps(snapshot));
  if (route === "setup") return sanitizeTerminalText(renderSetup(snapshot));
  if (route === "help") return sanitizeTerminalText(renderHelp(snapshot));
  if (route === "runtime") return sanitizeTerminalText(renderRuntime(snapshot, supervisor));
  if (route === "inspect") return sanitizeTerminalText(renderInspect(snapshot));
  return "";
}

export class RouteOverlay extends Text {}
