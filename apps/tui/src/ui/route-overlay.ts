import { Text } from "@earendil-works/pi-tui";

import type { SessionViewSnapshot, TuiRoute } from "../backend/slop-types";
import type { SupervisorSnapshot } from "../backend/supervisor-client";
import { projectIndicators } from "../projections/manifest-projection";
import { buildSlashEntries } from "../projections/slash-catalog";
import { sanitizeTerminalText, singleLineText } from "./render-safety";

// Untrusted fields embedded in list rows go through singleLineText so an
// embedded newline cannot forge an extra row (e.g. an approval reason that
// mimics another approval's status line). The outer sanitizeTerminalText in
// routeOverlayText stays as defense-in-depth for the intentional layout.

function line(value: string | undefined): string {
  const collapsed = singleLineText(value);
  return collapsed.length > 0 ? collapsed : "-";
}

function renderApprovals(snapshot: SessionViewSnapshot): string {
  if (snapshot.approvals.length === 0) return "No approvals.";
  return snapshot.approvals
    .map(
      (item) =>
        `${singleLineText(item.id)} ${singleLineText(item.status)} ${singleLineText(item.provider)}.${singleLineText(item.action)}\n  ${singleLineText(item.reason)}`,
    )
    .join("\n\n");
}

function renderTasks(snapshot: SessionViewSnapshot): string {
  if (snapshot.tasks.length === 0) return "No tasks.";
  return snapshot.tasks
    .map(
      (item) =>
        `${singleLineText(item.id)} ${singleLineText(item.status)} ${singleLineText(item.providerTaskId)}\n  ${singleLineText(item.message)}`,
    )
    .join("\n\n");
}

function renderApps(snapshot: SessionViewSnapshot): string {
  if (snapshot.apps.length === 0) return "No attached apps.";
  return snapshot.apps
    .map(
      (item) =>
        `${singleLineText(item.id)} ${singleLineText(item.status)} ${singleLineText(item.transport)}${item.lastError ? `\n  ${singleLineText(item.lastError)}` : ""}`,
    )
    .join("\n\n");
}

function renderSetup(snapshot: SessionViewSnapshot): string {
  const profiles = snapshot.llm.profiles
    .map((profile) => {
      const thinking = profile.thinkingEffectiveReason
        ? ` thinking=${profile.thinkingEffectiveEnabled ? "on" : "off"}/${singleLineText(profile.thinkingDisplay ?? "visible")}/${singleLineText(profile.thinkingEffort ?? "-")}`
        : "";
      const route = singleLineText(profile.endpointId ?? profile.adapterId ?? profile.kind);
      return `${singleLineText(profile.id)}${profile.isDefault ? " *" : ""} ${route}/${singleLineText(profile.model)} ${profile.ready ? "ready" : "not ready"}${thinking}`;
    })
    .join("\n");
  return [
    `LLM: ${singleLineText(snapshot.llm.status)}`,
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
    .map((indicator) => singleLineText(indicator.text))
    .join("\n");
  const sessions = (supervisor?.sessions ?? [])
    .map((session) => {
      const prefix = session.isResumeSession ? "*" : " ";
      return [
        prefix,
        singleLineText(session.id),
        singleLineText(session.runtimeStatus),
        `approval=${singleLineText(session.approvalMode)}`,
        session.title ? singleLineText(session.title) : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    })
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
  return [
    `${singleLineText(snapshot.inspect.targetName)} ${singleLineText(snapshot.inspect.path)}`,
    result ?? "",
  ].join("\n\n");
}

function renderHelp(snapshot: SessionViewSnapshot): string {
  const commands = buildSlashEntries(snapshot.plugins, { actionsByPath: snapshot.actionsByPath })
    .map((entry) => {
      const aliases = entry.aliases?.length
        ? ` (${entry.aliases.map((alias) => singleLineText(alias)).join(", ")})`
        : "";
      const signature = entry.signature ? ` ${singleLineText(entry.signature)}` : "";
      return `/${singleLineText(entry.name)}${signature}${aliases}\n  ${singleLineText(entry.description)}`;
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
