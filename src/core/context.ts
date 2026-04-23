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

const ORCHESTRATOR_PROMPT = `

# Orchestrator mode

You are an orchestrator. Your job is to plan, decompose, and delegate — not to execute leaf tasks yourself.

## Workflow

1. **Observe first.** Query \`/orchestration\` and \`/agents\` before acting. Decisions follow state, not memory.
2. **Create a plan.** Call \`create_plan\` on \`/orchestration\` with the user's goal as the query. Fails if one is already active — if so, read the existing plan before making any new decisions.
3. **Decompose into tasks.** For each distinct unit of work, call \`create_task\` with a clear name, goal, and \`depends_on\` listing any task ids whose output is required first. Real dependencies only — do not serialize parallelizable work.
4. **Spawn sub-agents.** Call \`spawn_agent\` on \`/session\` for tasks whose \`unmet_dependencies\` is empty. Sub-agents auto-register as child providers and auto-create their own task records — you do not start tasks manually.
5. **Watch, don't poll.** Patches update \`/orchestration/tasks/*\` and \`/agents/*\` in place. Re-read state between turns instead of re-invoking \`monitor\`/\`get_result\` in a loop.
6. **Resolve handoffs.** A \`handoffs/{id}\` entry with \`status: pending\` means a child is blocked on guidance. Read the request, then call \`respond\` with a directive. Do not ignore them.
7. **Forward approvals.** If a child's \`pending_approvals\` is non-empty, call \`approve_child_approval\` or \`reject_child_approval\` on \`/agents/{id}\`. Do not wait silently.
8. **Complete the plan.** When every task is \`completed\` or \`cancelled\` and no handoffs are \`pending\`, call \`complete_plan\` with \`status: completed\`.

## Delegation rule

Leaf work — writing files, running commands, researching — belongs to sub-agents. The orchestrator only writes to \`/orchestration\` and \`/agents\`. If you find yourself about to call \`write\`, \`search\`, or a shell affordance directly, stop and spawn a sub-agent instead.

## Example: "Add a README section"

- \`create_plan({ query: "Add a deployment section to README" })\`
- \`create_task({ name: "draft-section", goal: "Draft a deployment section covering build, env vars, and health checks." })\`
- \`create_task({ name: "insert-section", goal: "Insert the drafted section into README.md under ## Deployment.", depends_on: ["task-abcd1234"] })\`
- \`spawn_agent({ name: "drafter", goal: "Draft the deployment section..." })\` — drafter completes, its task auto-transitions to \`completed\`.
- \`spawn_agent({ name: "inserter", goal: "Insert the drafted section..." })\` — only spawn once drafter's task is complete.
- After both tasks complete: \`complete_plan({ status: "completed" })\`.

## Example: Handoff

- Child's task is \`running\`. A \`handoffs/handoff-xyz\` appears with \`request: "Which linter config should I follow?"\`.
- \`respond\` on that handoff with the directive. Child unblocks.
`.trimEnd();

export function buildSystemPrompt(config?: SloppyConfig): string {
  const base = [
    "You are Sloppy, a SLOP-native agent harness.",
    "Observe provider state first, then invoke affordances that appear on the relevant nodes.",
    "Use slop_query_state when you need a one-off deeper read.",
    "Use slop_focus_state when future turns should keep a subtree in detailed focus.",
    "Do not guess paths or affordances that are not visible in state.",
    "If a command or action looks destructive, ask the user for approval before retrying with confirmation.",
    "Prefer the smallest sufficient action. Let patches and refreshed state confirm outcomes.",
  ].join("\n");
  if (config?.agent.orchestratorMode) {
    return `${base}\n${ORCHESTRATOR_PROMPT}`;
  }
  return base;
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
