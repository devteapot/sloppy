import type { ActivityItem } from "../backend/slop-types";
import type { Verbosity } from "../state/commands";
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
  const header = `**Tool** ${status} ${label}${suffix ? ` ${suffix}` : ""}`;
  const summary = item.summary && item.summary !== label ? item.summary : undefined;

  if (options.verbosity === "compact" && item.status !== "error") {
    return [header, summary].filter(Boolean).join("\n");
  }

  const body =
    item.status === "error"
      ? renderErrorBody(item, options)
      : renderToolContent(item.result, options);
  return [header, summary, ...body].filter(Boolean).join("\n");
}

function renderErrorBody(
  item: ActivityItem,
  options: {
    verbosity: Verbosity;
    width: number;
  },
): string[] {
  const lines = [item.errorMessage ?? "Provider action failed."];
  if (item.result?.data !== undefined) {
    const json = JSON.stringify(item.result.data, null, 2);
    lines.push(["```json", json, "```"].join("\n"));
  }
  return options.verbosity === "compact" ? lines.slice(0, 1) : lines;
}

function statusToken(status: string): string {
  if (status === "ok") return "[ok]";
  if (status === "error") return "[error]";
  if (status === "accepted") return "[accepted]";
  if (status === "cancelled") return "[cancelled]";
  return "[running]";
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
