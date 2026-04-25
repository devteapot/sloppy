import { action, type ItemDescriptor } from "@slop-ai/server";

import type { DescriptorWiring } from "./descriptor-wiring";
import { normalizeStringList } from "./normalization";
import { truncateText } from "./storage";
import { OPTIONAL_EXPECTED_VERSION_PARAM } from "./types";

export function buildHandoffsDescriptor(wiring: DescriptorWiring) {
  const { repo, handoffs } = wiring;
  const handoffList = repo.listHandoffsForPlan();
  const items: ItemDescriptor[] = handoffList.map((handoff) => {
    const version = repo.handoffVersion(handoff.id);
    return {
      id: handoff.id,
      props: {
        id: handoff.id,
        plan_id: handoff.plan_id,
        from_task: handoff.from_task,
        to_task: handoff.to_task,
        kind: handoff.kind,
        priority: handoff.priority,
        request: handoff.request,
        spec_refs: handoff.spec_refs,
        evidence_refs: handoff.evidence_refs,
        blocks_task: handoff.blocks_task,
        status: handoff.status,
        created_at: handoff.created_at,
        responded_at: handoff.responded_at,
        response_preview: handoff.response ? truncateText(handoff.response, 400) : undefined,
        decision_refs: handoff.decision_refs,
        response_evidence_refs: handoff.response_evidence_refs,
        unblock: handoff.unblock,
        version,
      },
      summary: `${handoff.from_task} → ${handoff.to_task}: ${handoff.request.slice(0, 80)}`,
      actions: {
        ...(handoff.status === "pending"
          ? {
              respond: action(
                {
                  response: "string",
                  decision_refs: {
                    type: "array",
                    description: "Optional spec decision refs this response establishes or cites.",
                    items: { type: "string" },
                    optional: true,
                  },
                  evidence_refs: {
                    type: "array",
                    description:
                      "Optional files, commands, URLs, screenshots, or state paths that support the response.",
                    items: { type: "string" },
                    optional: true,
                  },
                  unblock: {
                    type: "boolean",
                    description:
                      "True when this response is intended to unblock the receiving task.",
                    optional: true,
                  },
                  expected_version: OPTIONAL_EXPECTED_VERSION_PARAM,
                },
                async ({ response, decision_refs, evidence_refs, unblock, expected_version }) =>
                  handoffs.respondHandoff({
                    handoff_id: handoff.id,
                    response: response as string,
                    decision_refs: normalizeStringList(decision_refs),
                    evidence_refs: normalizeStringList(evidence_refs),
                    unblock: typeof unblock === "boolean" ? unblock : undefined,
                    expected_version:
                      typeof expected_version === "number" ? expected_version : undefined,
                  }),
                {
                  label: "Respond",
                  description: "Fulfil the handoff request with a response.",
                  estimate: "instant",
                },
              ),
              cancel: action(
                { expected_version: OPTIONAL_EXPECTED_VERSION_PARAM },
                async ({ expected_version }) =>
                  handoffs.cancelHandoff({
                    handoff_id: handoff.id,
                    expected_version:
                      typeof expected_version === "number" ? expected_version : undefined,
                  }),
                {
                  label: "Cancel Handoff",
                  description: "Cancel this pending handoff request.",
                  dangerous: true,
                  estimate: "instant",
                },
              ),
            }
          : {}),
      },
      meta: {
        salience: handoff.status === "pending" ? 0.9 : 0.5,
        urgency: handoff.status === "pending" ? "high" : "low",
      },
    };
  });

  const pending = handoffList.filter((h) => h.status === "pending").length;
  return {
    type: "collection",
    props: {
      count: items.length,
      pending,
    },
    summary: `Handoffs between tasks (${pending} pending).`,
    items,
  };
}
