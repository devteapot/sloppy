import { action, type ItemDescriptor } from "@slop-ai/server";

import type { DescriptorWiring } from "./descriptor-wiring";

export function buildAuditDescriptor(wiring: DescriptorWiring) {
  const { repo, plans } = wiring;
  const audits = repo.listAudits();
  const items: ItemDescriptor[] = audits.map((audit) => ({
    id: audit.id,
    props: audit,
    summary: `${audit.status}: ${audit.replayed_checks.length} replayable checks`,
    meta: {
      salience: audit.status === "failed" ? 0.95 : 0.5,
      urgency: audit.status === "failed" ? "high" : "low",
    },
  }));

  return {
    type: "collection",
    props: {
      count: items.length,
      failed: audits.filter((audit) => audit.status === "failed").length,
    },
    summary: `Final audits (${items.length}).`,
    actions: {
      run_final_audit: action(async () => plans.runFinalAudit(), {
        label: "Run Final Audit",
        description:
          "Replay allowlisted evidence commands for the active plan and record a final audit result.",
        estimate: "fast",
      }),
    },
    items,
    meta: {
      salience: audits.some((audit) => audit.status === "failed") ? 0.95 : 0.45,
    },
  };
}
