import type { LlmTool } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../config/schema";
import type {
  ConversationHistoryEntrySnapshot,
  ConversationMessage,
  LlmAdapter,
  LlmResponse,
} from "../llm/types";
import { type ConversationHistory, renderEntry } from "./history";

const CHARS_PER_TOKEN_ESTIMATE = 4;
const REQUEST_OVERHEAD_TOKENS = 32;
const MESSAGE_OVERHEAD_TOKENS = 8;
const SUMMARY_INPUT_TOKEN_CEILING = 32_000;

const COMPACTION_SYSTEM_PROMPT = [
  "You compact conversation history for a coding agent.",
  "Preserve user requirements, constraints, decisions, completed work, failures, pending work, exact paths, commands, identifiers, and important tool results.",
  "Describe the current state and the next concrete step. Do not invent facts.",
  "Return only the continuation summary.",
].join("\n");

export type ContextBudget = {
  contextWindowTokens?: number;
  reserveTokens: number;
  usableInputTokens?: number;
  estimatedInputTokens: number;
};

export type ConversationCompactionResult = {
  compacted: boolean;
  firstRetainedIndex?: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  summaryCalls: LlmResponse[];
};

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

export function estimateMessageTokens(message: ConversationMessage): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(JSON.stringify(message));
}

export function estimateRequestTokens(input: {
  system: string;
  messages: ConversationMessage[];
  tools: LlmTool[];
}): number {
  return (
    REQUEST_OVERHEAD_TOKENS +
    estimateTextTokens(input.system) +
    input.messages.reduce((total, message) => total + estimateMessageTokens(message), 0) +
    estimateTextTokens(JSON.stringify(input.tools))
  );
}

export function buildContextBudget(options: {
  config: SloppyConfig;
  contextWindowTokens?: number;
  estimatedInputTokens: number;
  outputReserveTokens?: number;
}): ContextBudget {
  const configuredReserve = Math.max(
    options.outputReserveTokens ?? options.config.llm.maxTokens,
    options.config.agent.contextCompaction.reserveTokens,
  );
  const reserveTokens = options.contextWindowTokens
    ? Math.min(configuredReserve, Math.floor(options.contextWindowTokens / 2))
    : configuredReserve;
  return {
    contextWindowTokens: options.contextWindowTokens,
    reserveTokens,
    usableInputTokens: options.contextWindowTokens
      ? Math.max(1, options.contextWindowTokens - reserveTokens)
      : undefined,
    estimatedInputTokens: options.estimatedInputTokens,
  };
}

function validCutPoint(entry: ConversationHistoryEntrySnapshot): boolean {
  return entry.kind === "user" || entry.kind === "assistant";
}

function firstRetainedByTurns(
  entries: ConversationHistoryEntrySnapshot[],
  maxTurns: number,
): number {
  const userIndices = entries.flatMap((entry, index) => (entry.kind === "user" ? [index] : []));
  if (userIndices.length <= maxTurns) return 0;
  return userIndices[userIndices.length - maxTurns] ?? 0;
}

function firstRetainedByTokens(
  entries: ConversationHistoryEntrySnapshot[],
  keepRecentTokens: number,
): number {
  let accumulated = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    accumulated += estimateMessageTokens(entries[index]?.message ?? { role: "user", content: [] });
    if (accumulated < keepRecentTokens) continue;
    for (let candidate = index; candidate < entries.length; candidate += 1) {
      const entry = entries[candidate];
      if (entry && validCutPoint(entry)) return candidate;
    }
    return 0;
  }
  return 0;
}

export function selectFirstRetainedIndex(options: {
  entries: ConversationHistoryEntrySnapshot[];
  maxTurns: number;
  keepRecentTokens: number;
  force?: boolean;
}): number {
  const byTurns = firstRetainedByTurns(options.entries, options.maxTurns);
  const byTokens = firstRetainedByTokens(options.entries, options.keepRecentTokens);
  let selected = Math.max(byTurns, byTokens);
  if (selected === 0 && options.force) {
    selected = options.entries.findIndex((entry, index) => index > 0 && validCutPoint(entry));
  }
  return selected > 0 && selected < options.entries.length ? selected : 0;
}

function splitText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += maxChars) {
    chunks.push(text.slice(offset, offset + maxChars));
  }
  return chunks;
}

function buildSummaryChunks(
  entries: ConversationHistoryEntrySnapshot[],
  maxChars: number,
): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const entry of entries) {
    for (const piece of splitText(renderEntry(entry), maxChars)) {
      if (current && current.length + piece.length + 2 > maxChars) {
        chunks.push(current);
        current = "";
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function assistantText(response: LlmResponse): string {
  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

async function summarizeEntries(options: {
  entries: ConversationHistoryEntrySnapshot[];
  llm: LlmAdapter;
  contextWindowTokens?: number;
  summaryMaxTokens: number;
  signal?: AbortSignal;
  onSummaryCall?: (response: LlmResponse) => void;
}): Promise<{ summary: string; calls: LlmResponse[] }> {
  const inputBudget = Math.max(
    1024,
    Math.min(
      SUMMARY_INPUT_TOKEN_CEILING,
      (options.contextWindowTokens ?? SUMMARY_INPUT_TOKEN_CEILING) -
        options.summaryMaxTokens -
        1024,
    ),
  );
  const chunks = buildSummaryChunks(options.entries, inputBudget * CHARS_PER_TOKEN_ESTIMATE);
  const calls: LlmResponse[] = [];
  let summary = "";

  for (const chunk of chunks) {
    const prompt = summary
      ? `Update the existing continuation summary with the next history segment.\n\nEXISTING SUMMARY:\n${summary}\n\nNEXT HISTORY SEGMENT:\n${chunk}`
      : `Summarize this conversation history for continuation.\n\nHISTORY:\n${chunk}`;
    const response = await options.llm.chat({
      system: COMPACTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      maxTokens: options.summaryMaxTokens,
      signal: options.signal,
    });
    calls.push(response);
    options.onSummaryCall?.(response);
    const next = assistantText(response);
    if (!next) {
      throw new Error("Conversation compaction returned an empty summary.");
    }
    summary = next;
  }
  return { summary, calls };
}

export async function compactConversationHistory(options: {
  history: ConversationHistory;
  llm: LlmAdapter;
  config: SloppyConfig;
  contextWindowTokens?: number;
  estimatedTokensBefore: number;
  maxOutputTokens?: number;
  force?: boolean;
  signal?: AbortSignal;
  onSummaryCall?: (response: LlmResponse) => void;
}): Promise<ConversationCompactionResult> {
  const entries = options.history.activeEntries();
  if (!options.config.agent.contextCompaction.enabled || entries.length < 2) {
    return {
      compacted: false,
      estimatedTokensBefore: options.estimatedTokensBefore,
      estimatedTokensAfter: options.estimatedTokensBefore,
      summaryCalls: [],
    };
  }

  const usableInputTokens = buildContextBudget({
    config: options.config,
    contextWindowTokens: options.contextWindowTokens,
    estimatedInputTokens: options.estimatedTokensBefore,
    outputReserveTokens: options.maxOutputTokens,
  }).usableInputTokens;
  const overBudget =
    usableInputTokens !== undefined && options.estimatedTokensBefore > usableInputTokens;
  const overTurns = options.history.realUserTurnCount() > options.history.maxRecentTurns();
  if (!options.force && !overBudget && !overTurns) {
    return {
      compacted: false,
      estimatedTokensBefore: options.estimatedTokensBefore,
      estimatedTokensAfter: options.estimatedTokensBefore,
      summaryCalls: [],
    };
  }

  const keepRecentTokens = usableInputTokens
    ? Math.max(
        512,
        Math.min(
          options.config.agent.contextCompaction.keepRecentTokens,
          Math.floor(usableInputTokens / 2),
        ),
      )
    : options.config.agent.contextCompaction.keepRecentTokens;
  const firstRetainedIndex = selectFirstRetainedIndex({
    entries,
    maxTurns: options.history.maxRecentTurns(),
    keepRecentTokens,
    force: options.force,
  });
  if (firstRetainedIndex === 0) {
    return {
      compacted: false,
      estimatedTokensBefore: options.estimatedTokensBefore,
      estimatedTokensAfter: options.estimatedTokensBefore,
      summaryCalls: [],
    };
  }

  const summarized = await summarizeEntries({
    entries: entries.slice(0, firstRetainedIndex),
    llm: options.llm,
    contextWindowTokens: options.contextWindowTokens,
    summaryMaxTokens: Math.min(
      options.config.agent.contextCompaction.summaryMaxTokens,
      options.maxOutputTokens ?? Number.POSITIVE_INFINITY,
    ),
    signal: options.signal,
    onSummaryCall: options.onSummaryCall,
  });
  options.history.replaceActiveWithSummary({
    firstRetainedIndex,
    summary: summarized.summary,
  });
  const estimatedTokensAfter = options.history
    .activeEntries()
    .reduce((total, entry) => total + estimateMessageTokens(entry.message), 0);
  return {
    compacted: true,
    firstRetainedIndex,
    estimatedTokensBefore: options.estimatedTokensBefore,
    estimatedTokensAfter,
    summaryCalls: summarized.calls,
  };
}
