import type { ActivityItem } from "../backend/slop-types";
import type { Verbosity } from "../state/commands";
import { bold, dim, green, red } from "./theme";
import { renderToolContent } from "./tool-renderers";

export type ToolActivityPair = {
  call?: ActivityItem;
  result?: ActivityItem;
};

export function renderToolCallCard(
  pair: ToolActivityPair,
  options: {
    verbosity: Verbosity;
    width: number;
  },
): string {
  const item = pair.result ?? pair.call;
  if (!item) {
    return "";
  }
  const label = toolActivityLabel(pair);
  const status = statusToken(item.status);
  const suffix = toolActivityDuration(pair);
  const header = `${status} ${bold(label)}${suffix ? ` ${dim(suffix)}` : ""}`;
  const summary = isDuplicateSummary(item, label) ? undefined : item.summary;

  if (options.verbosity === "compact" && item.status !== "error") {
    const body = renderToolContent(item.result, options);
    return [header, ...body].filter(Boolean).join("\n");
  }

  const body =
    item.status === "error"
      ? renderErrorBody(item, options)
      : renderToolContent(item.result, options);
  return [header, summary, ...body].filter(Boolean).join("\n");
}

export function renderToolCallGroup(
  pairs: ToolActivityPair[],
  options: {
    verbosity: Verbosity;
    width: number;
  },
): string {
  const first = pairs[0];
  if (!first) {
    return "";
  }
  const header = bold(toolActivityLabel(first));
  const rows = pairs.map((pair) => renderToolCallRow(pair, options)).filter(Boolean);
  return [header, ...rows].join("\n");
}

export function toolActivityLabel(pair: ToolActivityPair): string {
  const item = pair.result ?? pair.call;
  return item ? toolLabel(item) : "Tool call";
}

export function toolActivityGroupKey(pair: ToolActivityPair): string {
  const item = pair.result ?? pair.call;
  if (!item) {
    return "unknown";
  }
  return [item.provider ?? "", item.action ?? "", toolLabel(item), item.result?.kind ?? ""].join(
    "\u001f",
  );
}

export function toolActivityDuration(pair: ToolActivityPair): string | null {
  return duration(pair.call, pair.result);
}

function renderToolCallRow(
  pair: ToolActivityPair,
  options: {
    verbosity: Verbosity;
    width: number;
  },
): string {
  const item = pair.result ?? pair.call;
  if (!item) {
    return "";
  }
  const status = statusToken(item.status);
  const detail = rowDetail(pair, options);
  const suffix = toolActivityDuration(pair);
  return [status, detail, suffix ? dim(suffix) : undefined].filter(Boolean).join(" ");
}

function rowDetail(
  pair: ToolActivityPair,
  options: {
    verbosity: Verbosity;
    width: number;
  },
): string {
  const item = pair.result ?? pair.call;
  if (!item) {
    return "";
  }
  if (item.status === "error") {
    return red(item.errorMessage ?? "Provider action failed.");
  }
  const body = renderToolContent(item.result, { ...options, verbosity: "compact" });
  const firstBodyLine = body.find((line) => line.trim().length > 0);
  if (firstBodyLine) {
    return firstBodyLine;
  }
  const label = toolLabel(item);
  return isDuplicateSummary(item, label) ? dim("started") : item.summary;
}

function toolLabel(item: ActivityItem): string {
  const label = item.label?.trim();
  if (label) {
    return label;
  }

  const summary = item.summary.trim();
  if (summary && !isRawActionSummary(item, summary)) {
    return summary;
  }

  return humanizeAction(item.action ?? item.provider ?? "tool call");
}

function humanizeAction(value: string): string {
  const words = value.replace(/__/g, "_").split(/[_-]+/).filter(Boolean);
  const text = words.length > 0 ? words.join(" ") : "tool call";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isRawActionSummary(item: ActivityItem, normalized: string): boolean {
  const rawLabel = `${item.provider ?? "provider"}:${item.action ?? "action"}`;
  return normalized === rawLabel || normalized.startsWith(`${rawLabel} `);
}

function isDuplicateSummary(item: ActivityItem, label: string): boolean {
  if (!item.summary) {
    return true;
  }
  const normalized = item.summary.trim();
  if (normalized === label) {
    return true;
  }
  const rawLabel = `${item.provider ?? "provider"}:${item.action ?? "action"}`;
  if (normalized === rawLabel || normalized.startsWith(`${rawLabel} `)) {
    return true;
  }
  return item.path ? normalized === `${label} ${item.path}` : false;
}

function renderErrorBody(
  item: ActivityItem,
  options: {
    verbosity: Verbosity;
    width: number;
  },
): string[] {
  const lines = [red(item.errorMessage ?? "Provider action failed.")];
  if (item.result?.data !== undefined) {
    lines.push(JSON.stringify(item.result.data, null, 2));
  }
  return options.verbosity === "compact" ? lines.slice(0, 1) : lines;
}

function statusToken(status: string): string {
  if (status === "ok") return green("✓");
  if (status === "error") return red("✗");
  if (status === "accepted") return dim("…");
  if (status === "cancelled") return dim("×");
  return dim("…");
}

function duration(call: ActivityItem | undefined, result: ActivityItem | undefined): string | null {
  if (!call?.startedAt || !result?.completedAt) {
    return null;
  }
  const started = Date.parse(call.startedAt);
  const completed = Date.parse(result.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    return null;
  }
  return `${completed - started}ms`;
}
