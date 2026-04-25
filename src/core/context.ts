import { type SlopNode as ConsumerSlopNode, formatTree } from "@slop-ai/consumer/browser";
import { countNodes, prepareTree } from "@slop-ai/core";

import type { SloppyConfig } from "../config/schema";
import { buildVisibleTree, type ProviderTreeView } from "./subscriptions";

const CHARS_PER_TOKEN_ESTIMATE = 4;

function formatContextSections(
  views: ProviderTreeView[],
  options: {
    minSalience: number;
    maxDepth: number;
    maxNodes: number;
  },
) {
  return views.map((view) => {
    const visibleTree = buildVisibleTree(view);
    const prepared = prepareTree(visibleTree, {
      minSalience: options.minSalience,
      maxDepth: options.maxDepth,
      maxNodes: options.maxNodes,
    });

    const detailLabel = view.detailPath ? ` focus=${view.detailPath}` : "";
    return {
      text: `### ${view.providerId} (${view.providerName}, ${view.kind}${detailLabel})\n${formatTree(prepared as unknown as ConsumerSlopNode)}`,
      nodeCount: countNodes(prepared),
    };
  });
}

export function buildSystemPrompt(_config?: SloppyConfig, fragments: string[] = []): string {
  const base = [
    "You are Sloppy, a SLOP-native agent harness.",
    "Observe provider state first, then invoke affordances that appear on the relevant nodes.",
    "Use slop_query_state when you need a one-off deeper read.",
    "Use slop_focus_state when future turns should keep a subtree in detailed focus.",
    "Do not guess paths or affordances that are not visible in state.",
    "If a command or action looks destructive, ask the user for approval before retrying with confirmation.",
    "Prefer the smallest sufficient action. Let patches and refreshed state confirm outcomes.",
    "When you create or change runnable code and a suitable project check is available, run the narrowest build/test/lint command before reporting completion; surface failures instead of marking the task done.",
  ].join("\n");
  const extras = fragments.filter((fragment) => fragment && fragment.trim().length > 0);
  if (extras.length === 0) {
    return base;
  }
  return [base, ...extras].join("\n");
}

export function buildStateContext(views: ProviderTreeView[], config: SloppyConfig): string {
  if (views.length === 0) {
    return "No SLOP providers are currently connected.";
  }

  const maxChars = config.agent.contextBudgetTokens * CHARS_PER_TOKEN_ESTIMATE;
  const attempts = [
    {
      minSalience: config.agent.minSalience,
      maxDepth: config.agent.detailDepth,
      maxNodes: config.agent.detailMaxNodes,
    },
    {
      minSalience: Math.max(config.agent.minSalience, 0.35),
      maxDepth: Math.max(2, config.agent.detailDepth - 1),
      maxNodes: Math.max(120, Math.floor(config.agent.detailMaxNodes * 0.75)),
    },
    {
      minSalience: 0.5,
      maxDepth: 2,
      maxNodes: 80,
    },
    {
      minSalience: 0.7,
      maxDepth: 1,
      maxNodes: 40,
    },
  ];

  for (const attempt of attempts) {
    const sections = formatContextSections(views, attempt);
    const combined = sections.map((section) => section.text).join("\n\n");
    if (combined.length <= maxChars) {
      return combined;
    }
  }

  const fallback = formatContextSections(views, {
    minSalience: 0.8,
    maxDepth: 1,
    maxNodes: 25,
  })
    .map((section) => section.text)
    .join("\n\n");

  return fallback.slice(0, maxChars);
}
