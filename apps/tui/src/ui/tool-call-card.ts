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
  const status = statusToken(item.status);
  const label = `${item.provider ?? "provider"}:${item.action ?? "action"}`;
  const suffix = [item.path, duration(pair.call, pair.result)].filter(Boolean).join(" ");
  const header = `${bold("Tool")} ${status} ${label}${suffix ? ` ${suffix}` : ""}`;
  const summary = isDuplicateSummary(item.summary, label, item.path) ? undefined : item.summary;

  if (options.verbosity === "compact" && item.status !== "error") {
    return [header, summary].filter(Boolean).join("\n");
  }

  const body =
    item.status === "error"
      ? renderErrorBody(item, options)
      : renderToolContent(item.result, options);
  return [header, summary, ...body].filter(Boolean).join("\n");
}

function isDuplicateSummary(
  summary: string | undefined,
  label: string,
  path: string | undefined,
): boolean {
  if (!summary) {
    return true;
  }
  const normalized = summary.trim();
  if (normalized === label) {
    return true;
  }
  return path ? normalized === `${label} ${path}` : false;
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
  if (status === "ok") return green("[ok]");
  if (status === "error") return red("[error]");
  if (status === "accepted") return dim("[accepted]");
  if (status === "cancelled") return dim("[cancelled]");
  return dim("[running]");
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
