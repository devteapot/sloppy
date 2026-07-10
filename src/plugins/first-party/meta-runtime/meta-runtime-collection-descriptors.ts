import { action, type ItemDescriptor, type NodeDescriptor } from "@slop-ai/server";

import type { Proposal, TopologyPattern } from "./meta-runtime-model";
import { listById, listByName } from "./meta-runtime-model";

export function buildMetaRuntimeProposalsDescriptor(options: {
  proposals: Map<string, Proposal>;
  requiresApproval: (proposal: Proposal) => boolean;
  applyProposal: (id: string) => unknown;
  revertProposal: (id: string) => unknown;
}): NodeDescriptor {
  const items: ItemDescriptor[] = listById(options.proposals).map((proposal) => {
    const requiresApproval = options.requiresApproval(proposal);
    return {
      id: proposal.id,
      props: { ...proposal, requiresApproval },
      summary: proposal.summary,
      actions: {
        ...(proposal.status === "proposed"
          ? {
              apply_proposal: action(async () => options.applyProposal(proposal.id), {
                label: "Apply Proposal",
                description:
                  "Apply this topology proposal. Privileged or persistent changes request approval.",
                dangerous: requiresApproval,
                estimate: "fast",
              }),
              revert_proposal: action(async () => options.revertProposal(proposal.id), {
                label: "Revert Proposal",
                description: "Mark this proposed topology change as reverted.",
                estimate: "instant",
              }),
            }
          : {}),
      },
      meta: {
        urgency: requiresApproval && proposal.status === "proposed" ? "high" : "low",
      },
    };
  });

  return {
    type: "collection",
    props: {
      count: items.length,
    },
    summary: "Pending and resolved meta-runtime topology proposals.",
    items,
  };
}

export function buildMetaRuntimePatternsDescriptor(options: {
  patterns: Map<string, TopologyPattern>;
  proposeFromPattern: (params: Record<string, unknown>) => unknown;
}): NodeDescriptor {
  const items: ItemDescriptor[] = listByName(options.patterns).map((pattern) => ({
    id: pattern.id,
    props: pattern,
    summary: pattern.summary ?? pattern.name,
    actions: {
      propose_from_pattern: action(
        {
          scope: {
            type: "string",
            enum: ["session", "workspace", "global"],
            optional: true,
          },
          summary: {
            type: "string",
            optional: true,
          },
          rationale: {
            type: "string",
            optional: true,
          },
          ttl_ms: {
            type: "number",
            optional: true,
          },
          ops: {
            type: "array",
            description:
              "Explicit typed TopologyChange operations adapted from this pattern for the current graph.",
            items: { type: "object", additionalProperties: true },
          },
        },
        (params) => options.proposeFromPattern({ ...params, pattern_id: pattern.id }),
        {
          label: "Propose From Pattern",
          description:
            "Create a topology proposal from this archived pattern using explicit adapted operations.",
          estimate: "fast",
        },
      ),
    },
  }));

  return {
    type: "collection",
    props: {
      count: items.length,
    },
    summary: "Reusable topology patterns archived from promoted experiments.",
    items,
  };
}

export function buildMetaRuntimeCollectionDescriptor(
  name: string,
  items: Array<Record<string, unknown>>,
): NodeDescriptor {
  return {
    type: "collection",
    props: {
      count: items.length,
    },
    summary: `Meta-runtime ${name}.`,
    items: items.map((item) => ({
      id: String(item.id),
      props: item,
      summary: String(item.name ?? item.summary ?? item.id),
    })),
  };
}
