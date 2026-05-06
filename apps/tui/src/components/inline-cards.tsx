import { TextAttributes } from "@opentui/core";
import { For, Show } from "solid-js";
import { COLORS } from "../lib/theme";
import type { ActivityItem, ApprovalItem, TaskItem } from "../slop/types";

export function InlineApprovalCard(props: { approval: ApprovalItem }) {
  return (
    <box
      flexDirection="column"
      marginTop={1}
      paddingX={1}
      paddingY={0}
      border
      borderColor={props.approval.dangerous ? COLORS.red : COLORS.yellow}
      backgroundColor={COLORS.panel}
    >
      <text
        fg={props.approval.dangerous ? COLORS.red : COLORS.yellow}
        attributes={TextAttributes.BOLD}
        content={`▸ approval needed: ${props.approval.provider}.${props.approval.action}`}
      />
      <text fg={COLORS.text} wrapMode="word" content={props.approval.reason} />
      <Show when={props.approval.paramsPreview}>
        <text fg={COLORS.dim} wrapMode="word" content={props.approval.paramsPreview} />
      </Show>
      <text
        fg={COLORS.cyan}
        content={
          props.approval.dangerous
            ? "  [Shift+a] approve · [d/esc] deny · DANGEROUS"
            : "  [a] approve · [d/esc] deny"
        }
      />
    </box>
  );
}

export function InlineTaskCard(props: { task: TaskItem }) {
  const progress = () =>
    typeof props.task.progress === "number" ? ` ${Math.round(props.task.progress * 100)}%` : "";
  return (
    <box flexDirection="column" marginTop={0} paddingX={1} backgroundColor={COLORS.base}>
      <text
        fg={COLORS.cyan}
        content={`  ⚙ task ${props.task.provider}${progress()} · ${props.task.message || props.task.providerTaskId}`}
      />
    </box>
  );
}

export type ToolEntry = {
  id: string;
  status: string;
  provider?: string;
  action?: string;
  path?: string;
  summary: string;
  paramsPreview?: string;
};

const TOOL_RUNNING_STATUSES = new Set(["running", "pending", "waiting"]);

function statusColor(status: string): string {
  if (TOOL_RUNNING_STATUSES.has(status)) return COLORS.cyan;
  if (status === "ok" || status === "accepted" || status === "completed") return COLORS.green;
  if (status === "cancelled") return COLORS.yellow;
  return COLORS.red;
}

function statusGlyph(status: string): string {
  if (TOOL_RUNNING_STATUSES.has(status)) return "⋯";
  if (status === "ok" || status === "accepted" || status === "completed") return "✓";
  if (status === "cancelled") return "⊘";
  return "✗";
}

const EDIT_ACTION_PATTERN = /(write|edit|patch|apply)/i;

export function InlineToolLine(props: { entry: ToolEntry; alwaysPreview?: boolean }) {
  const target = () => {
    const head = [props.entry.provider, props.entry.action].filter(Boolean).join(".");
    return head || props.entry.action || "tool";
  };
  const showPreview = () =>
    !!props.entry.paramsPreview &&
    (props.alwaysPreview || (!!props.entry.action && EDIT_ACTION_PATTERN.test(props.entry.action)));
  const previewLines = () => (props.entry.paramsPreview ?? "").split(/\r?\n/);
  return (
    <box flexDirection="column">
      <text
        fg={statusColor(props.entry.status)}
        truncate
        content={`  ${statusGlyph(props.entry.status)} ${target()}${props.entry.path ? ` ${props.entry.path}` : ""}${props.entry.summary && !TOOL_RUNNING_STATUSES.has(props.entry.status) ? ` · ${truncateSummary(props.entry.summary)}` : ""}`}
      />
      <Show when={showPreview()}>
        <For each={previewLines()}>
          {(line) => <text fg={diffLineColor(line)} truncate content={`    ${line}`} />}
        </For>
      </Show>
    </box>
  );
}

function diffLineColor(line: string): string {
  if (line.startsWith("+")) return COLORS.green;
  if (line.startsWith("-")) return COLORS.red;
  if (line.startsWith("@@")) return COLORS.cyan;
  return COLORS.dim;
}

function truncateSummary(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
}

export function collapseTurnTools(activity: ActivityItem[], turnId: string): ToolEntry[] {
  // tool_call/tool_result share toolUseId; result wins (terminal status).
  const byId = new Map<string, ToolEntry>();
  for (const item of activity) {
    if (item.turnId !== turnId) continue;
    if (item.kind !== "tool_call" && item.kind !== "tool_result") continue;
    const key = item.toolUseId ?? item.id;
    const existing = byId.get(key);
    if (item.kind === "tool_call" && existing) continue;
    byId.set(key, {
      id: key,
      status: item.status,
      provider: item.provider,
      action: item.action,
      path: item.path,
      summary: item.summary,
      paramsPreview: item.paramsPreview ?? existing?.paramsPreview,
    });
  }
  return [...byId.values()];
}
