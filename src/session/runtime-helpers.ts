import { join, resolve } from "node:path";

import type { ResultMessage } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../config/schema";
import { renderEditDiff } from "../core/diff";
import { getDefaultEndpointModel } from "../llm/catalog";
import type { ToolResultContentBlock } from "../llm/types";
import type { SessionRuntimePlugin } from "./plugins";
import type { JsonValue, SessionStoreEventType, ToolCallResult } from "./types";

export function runtimeConfigFingerprint(config: SloppyConfig): string {
  return JSON.stringify({
    agent: config.agent,
    maxToolResultSize: config.maxToolResultSize,
    plugins: config.plugins,
    providers: config.providers,
  });
}

export function mergePluginExtensionEventTypes(
  plugins: readonly SessionRuntimePlugin[],
): Record<string, readonly SessionStoreEventType[]> {
  const result: Record<string, SessionStoreEventType[]> = {};
  for (const plugin of plugins) {
    for (const [namespace, eventTypes] of Object.entries(plugin.extensionEvents ?? {})) {
      result[namespace] = [...(result[namespace] ?? []), ...eventTypes];
    }
  }
  return result;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-") || "session";
}

export function resolveSessionPersistencePath(
  config: SloppyConfig,
  sessionId: string,
  explicitPath: string | false | undefined,
): string | undefined {
  if (explicitPath === false) {
    return undefined;
  }
  if (explicitPath) {
    return resolve(explicitPath);
  }
  if (config.session?.persistSnapshots !== true) {
    return undefined;
  }
  const dir = config.session.persistenceDir ?? ".sloppy/sessions";
  const absoluteDir = resolve(config.plugins.filesystem.root, dir);
  return join(absoluteDir, `${sanitizePathSegment(sessionId)}.json`);
}

export function resolveInitialLlmRoute(config: SloppyConfig): {
  endpointId: string;
  model: string;
} {
  const activeProfile = config.llm.profiles.find(
    (profile) => profile.id === config.llm.defaultProfileId,
  );
  const profile = activeProfile ?? config.llm.profiles[0];
  if (profile?.kind === "native") {
    return {
      endpointId: profile.endpointId,
      model: profile.model,
    };
  }
  if (profile?.kind === "session-agent") {
    return {
      endpointId: profile.adapterId,
      model: profile.model,
    };
  }

  const endpointId = "anthropic";
  return {
    endpointId,
    model:
      getDefaultEndpointModel(endpointId) ??
      Object.keys(config.llm.endpoints[endpointId]?.models ?? {})[0] ??
      "default",
  };
}

export function parseProfileKind(value: unknown): "native" | "session-agent" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "native" || value === "session-agent") {
    return value;
  }
  throw new Error("LLM profile kind must be 'native' or 'session-agent'.");
}

function stringifyResultMessage(result: ResultMessage): string {
  if (result.status === "error") {
    return result.error?.message ?? "Provider action failed.";
  }

  return JSON.stringify(result, null, 2);
}

export function buildToolResultBlock(
  toolUseId: string,
  result: ResultMessage,
): ToolResultContentBlock {
  return {
    type: "tool_result",
    toolUseId,
    content: stringifyResultMessage(result),
    isError: result.status === "error",
  };
}

const PARAMS_PREVIEW_BYTE_LIMIT = 1500;
const PARAMS_PREVIEW_LINE_LIMIT = 24;
const TOOL_RESULT_BYTE_LIMIT = 12000;
const TOOL_RESULT_STRING_BYTE_LIMIT = 4000;
const TOOL_RESULT_ARRAY_ITEM_LIMIT = 100;
const TOOL_RESULT_OBJECT_ENTRY_LIMIT = 100;

// Compact a tool's params into a multi-line preview for the activity feed.
// Edit-shaped actions (write/edit/patch) put the new content/hunks first so
// the TUI can render a diff-like block; everything else falls back to a
// stable JSON dump capped at PARAMS_PREVIEW_BYTE_LIMIT.
export function previewToolParams(
  action: string,
  params: Record<string, unknown>,
): string | undefined {
  if (!params || Object.keys(params).length === 0) {
    return undefined;
  }
  const lower = action.toLowerCase();
  if (lower.includes("write") || lower.includes("edit") || lower.includes("patch")) {
    const diff = renderEditDiff(params);
    if (diff) return clampPreview(diff);
    const preferred = ["new_string", "content", "patch", "diff"];
    for (const key of preferred) {
      const value = params[key];
      if (typeof value === "string" && value.length > 0) {
        return clampPreview(value);
      }
    }
  }
  let json: string;
  try {
    json = JSON.stringify(params, null, 2);
  } catch {
    return undefined;
  }
  return clampPreview(json);
}

function clampPreview(value: string): string {
  const lines = value.split(/\r?\n/);
  let truncatedLines = lines;
  if (lines.length > PARAMS_PREVIEW_LINE_LIMIT) {
    truncatedLines = [
      ...lines.slice(0, PARAMS_PREVIEW_LINE_LIMIT),
      `… +${lines.length - PARAMS_PREVIEW_LINE_LIMIT} lines`,
    ];
  }
  const out = truncatedLines.join("\n");
  if (out.length <= PARAMS_PREVIEW_BYTE_LIMIT) {
    return out;
  }
  return `${out.slice(0, PARAMS_PREVIEW_BYTE_LIMIT)}…`;
}

export function boundToolResult(
  input: { kind?: string; data?: unknown } | undefined,
): ToolCallResult | undefined {
  if (!input) {
    return undefined;
  }
  const kind =
    typeof input.kind === "string" && input.kind.trim().length > 0 ? input.kind.trim() : undefined;
  const budget = { remaining: TOOL_RESULT_BYTE_LIMIT, truncated: false };
  const data =
    Object.hasOwn(input, "data") && input.data !== undefined
      ? boundJsonValue(input.data, budget, new WeakSet<object>())
      : undefined;
  if (!kind && data === undefined) {
    return undefined;
  }
  return {
    ...(kind ? { kind } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(budget.truncated ? { truncated: true } : {}),
  };
}

function boundJsonValue(
  value: unknown,
  budget: { remaining: number; truncated: boolean },
  seen: WeakSet<object>,
): JsonValue {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return "[truncated]";
  }
  if (value === null || typeof value === "boolean") {
    budget.remaining -= 4;
    return value;
  }
  if (typeof value === "number") {
    budget.remaining -= 16;
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "string") {
    const limit = Math.min(TOOL_RESULT_STRING_BYTE_LIMIT, Math.max(0, budget.remaining));
    if (value.length > limit) {
      budget.truncated = true;
      budget.remaining = 0;
      return `${value.slice(0, Math.max(0, limit - 16))}\n...[truncated]`;
    }
    budget.remaining -= value.length;
    return value;
  }
  if (typeof value === "bigint") {
    const out = value.toString();
    budget.remaining -= out.length;
    return out;
  }
  if (typeof value !== "object") {
    const out = String(value);
    budget.remaining -= out.length;
    return out;
  }
  if (seen.has(value)) {
    budget.truncated = true;
    return "[circular]";
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (index >= TOOL_RESULT_ARRAY_ITEM_LIMIT || budget.remaining <= 0) {
          budget.truncated = true;
          break;
        }
        out.push(boundJsonValue(value[index], budget, seen));
      }
      return out;
    }

    const out: Record<string, JsonValue> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (let index = 0; index < entries.length; index += 1) {
      if (index >= TOOL_RESULT_OBJECT_ENTRY_LIMIT || budget.remaining <= 0) {
        budget.truncated = true;
        break;
      }
      const [key, entryValue] = entries[index] ?? ["", undefined];
      if (!key || entryValue === undefined || typeof entryValue === "function") {
        continue;
      }
      budget.remaining -= key.length;
      out[key] = boundJsonValue(entryValue, budget, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
