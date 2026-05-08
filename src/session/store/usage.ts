import type { SessionUsageSnapshot, TokenAccountingSource } from "../types";
import { now } from "./helpers";
import type { SessionStoreState } from "./state";

export function emptyUsage(): SessionUsageSnapshot {
  return {
    lastModelCallInputSource: "unavailable",
    lastModelCallOutputSource: "unavailable",
    currentTurnModelCalls: 0,
    lastStateContextTokenSource: "unavailable",
  };
}

export function normalizeUsage(usage: SessionUsageSnapshot | undefined): SessionUsageSnapshot {
  const base = usage ?? emptyUsage();
  return {
    lastTurnId: base.lastTurnId,
    lastModelCallInputTokens: base.lastModelCallInputTokens,
    lastModelCallOutputTokens: base.lastModelCallOutputTokens,
    lastModelCallInputSource: base.lastModelCallInputSource ?? "unavailable",
    lastModelCallOutputSource: base.lastModelCallOutputSource ?? "unavailable",
    currentTurnInputTokens: base.currentTurnInputTokens,
    currentTurnOutputTokens: base.currentTurnOutputTokens,
    currentTurnModelCalls: base.currentTurnModelCalls ?? 0,
    totalInputTokens: base.totalInputTokens,
    totalOutputTokens: base.totalOutputTokens,
    lastStateContextTokens: base.lastStateContextTokens,
    lastStateContextTokenSource: base.lastStateContextTokenSource ?? "unavailable",
    modelContextWindowTokens: base.modelContextWindowTokens,
    availableContextTokens: base.availableContextTokens,
    updatedAt: base.updatedAt,
  };
}

export function recordUsage(
  state: SessionStoreState,
  options: {
    turnId?: string;
    inputTokens?: number;
    outputTokens?: number;
    inputTokenSource: TokenAccountingSource;
    outputTokenSource: TokenAccountingSource;
    stateContextTokens?: number;
    stateContextTokenSource?: TokenAccountingSource;
    modelContextWindowTokens?: number;
    availableContextTokens?: number;
  },
): void {
  const previous = normalizeUsage(state.snapshot.usage);
  const sameTurn = options.turnId !== undefined && options.turnId === previous.lastTurnId;
  const countsAsModelCall =
    options.turnId !== undefined ||
    options.inputTokens !== undefined ||
    options.outputTokens !== undefined ||
    options.stateContextTokens !== undefined;
  const currentTurnInputTokens =
    options.inputTokens === undefined
      ? sameTurn
        ? previous.currentTurnInputTokens
        : undefined
      : (sameTurn ? (previous.currentTurnInputTokens ?? 0) : 0) + options.inputTokens;
  const currentTurnOutputTokens =
    options.outputTokens === undefined
      ? sameTurn
        ? previous.currentTurnOutputTokens
        : undefined
      : (sameTurn ? (previous.currentTurnOutputTokens ?? 0) : 0) + options.outputTokens;
  const totalInputTokens =
    options.inputTokens === undefined
      ? previous.totalInputTokens
      : (previous.totalInputTokens ?? 0) + options.inputTokens;
  const totalOutputTokens =
    options.outputTokens === undefined
      ? previous.totalOutputTokens
      : (previous.totalOutputTokens ?? 0) + options.outputTokens;
  const modelContextWindowTokens =
    options.modelContextWindowTokens ?? previous.modelContextWindowTokens;
  const availableContextTokens =
    options.availableContextTokens ??
    (modelContextWindowTokens !== undefined && options.inputTokens !== undefined
      ? Math.max(0, modelContextWindowTokens - options.inputTokens)
      : undefined);
  const next: SessionUsageSnapshot = {
    lastTurnId: options.turnId,
    lastModelCallInputTokens: options.inputTokens,
    lastModelCallOutputTokens: options.outputTokens,
    lastModelCallInputSource: options.inputTokenSource,
    lastModelCallOutputSource: options.outputTokenSource,
    currentTurnInputTokens,
    currentTurnOutputTokens,
    currentTurnModelCalls:
      (sameTurn ? previous.currentTurnModelCalls : 0) + (countsAsModelCall ? 1 : 0),
    totalInputTokens,
    totalOutputTokens,
    lastStateContextTokens: options.stateContextTokens,
    lastStateContextTokenSource: options.stateContextTokenSource ?? "unavailable",
    modelContextWindowTokens,
    availableContextTokens,
    updatedAt: now(),
  };
  state.snapshot.usage = next;
  state.usageChanged = true;
}

export function syncModelContext(
  state: SessionStoreState,
  options: {
    modelContextWindowTokens?: number;
  },
): void {
  const previous = normalizeUsage(state.snapshot.usage);
  const availableContextTokens =
    options.modelContextWindowTokens !== undefined &&
    previous.lastModelCallInputTokens !== undefined
      ? Math.max(0, options.modelContextWindowTokens - previous.lastModelCallInputTokens)
      : undefined;
  state.snapshot.usage = {
    ...previous,
    modelContextWindowTokens: options.modelContextWindowTokens,
    availableContextTokens,
    updatedAt: now(),
  };
  state.usageChanged = true;
}
