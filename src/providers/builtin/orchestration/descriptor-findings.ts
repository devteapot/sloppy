import { action, type ItemDescriptor } from "@slop-ai/server";

import type { DescriptorWiring } from "./descriptor-wiring";
import {
  normalizeFindingRecommendation,
  normalizeFindingSeverity,
  normalizeStringList,
} from "./normalization";

export function buildFindingsDescriptor(wiring: DescriptorWiring) {
  const { repo, findings } = wiring;
  const findingList = repo.listFindingsForPlan();
  const items: ItemDescriptor[] = findingList.map((finding) => ({
    id: finding.id,
    props: {
      ...finding,
      version: repo.findingVersion(finding.id),
    },
    summary: `${finding.severity}/${finding.status}: ${finding.summary}`,
    actions: {
      ...(finding.status === "open"
        ? {
            accept_finding: action(
              {
                reason: {
                  type: "string",
                  description: "Optional explanation for accepting this deviation from the spec.",
                  optional: true,
                },
              },
              async ({ reason }) =>
                findings.resolveFinding({
                  finding_id: finding.id,
                  status: "accepted",
                  reason: typeof reason === "string" ? reason : undefined,
                }),
              {
                label: "Accept Finding",
                description:
                  "Accept this finding as an intentional deviation or follow-up decision.",
                estimate: "instant",
              },
            ),
            dismiss_finding: action(
              {
                reason: {
                  type: "string",
                  description: "Optional explanation for dismissing this finding.",
                  optional: true,
                },
              },
              async ({ reason }) =>
                findings.resolveFinding({
                  finding_id: finding.id,
                  status: "dismissed",
                  reason: typeof reason === "string" ? reason : undefined,
                }),
              {
                label: "Dismiss Finding",
                description: "Dismiss this finding as not actionable.",
                estimate: "instant",
              },
            ),
            mark_fixed: action(
              {
                reason: {
                  type: "string",
                  description: "Optional evidence summary for the fix.",
                  optional: true,
                },
              },
              async ({ reason }) =>
                findings.resolveFinding({
                  finding_id: finding.id,
                  status: "fixed",
                  reason: typeof reason === "string" ? reason : undefined,
                }),
              {
                label: "Mark Fixed",
                description: "Mark this finding fixed after repair and re-audit.",
                estimate: "instant",
              },
            ),
            create_repair_task: action(
              {
                name: {
                  type: "string",
                  description: "Optional repair task name.",
                  optional: true,
                },
                goal: {
                  type: "string",
                  description: "Optional repair task goal.",
                  optional: true,
                },
                acceptance_criteria: {
                  type: "array",
                  description: "Optional acceptance criteria for the repair task.",
                  items: { type: "string" },
                  optional: true,
                },
              },
              async ({ name, goal, acceptance_criteria }) =>
                findings.createRepairTask({
                  finding_id: finding.id,
                  name: typeof name === "string" ? name : undefined,
                  goal: typeof goal === "string" ? goal : undefined,
                  acceptance_criteria: normalizeStringList(acceptance_criteria),
                }),
              {
                label: "Create Repair Task",
                description:
                  "Create a repair task linked to this finding. The finding remains open until fixed or accepted.",
                estimate: "instant",
              },
            ),
          }
        : {}),
    },
    meta: {
      salience:
        finding.status === "open" && finding.severity === "blocking"
          ? 1
          : finding.status === "open"
            ? 0.85
            : 0.45,
      urgency:
        finding.status === "open" && finding.severity === "blocking"
          ? "high"
          : finding.status === "open"
            ? "medium"
            : "low",
    },
  }));

  return {
    type: "collection",
    props: {
      count: items.length,
      open: findingList.filter((finding) => finding.status === "open").length,
      blocking_open: findingList.filter(
        (finding) => finding.status === "open" && finding.severity === "blocking",
      ).length,
    },
    summary: "Audit findings recorded against orchestration tasks and spec refs.",
    actions: {
      record_finding: action(
        {
          audit_task_id: "string",
          target_task_id: "string",
          severity: {
            type: "string",
            description: "Finding severity: blocking, warning, or note.",
            enum: ["blocking", "warning", "note"],
          },
          spec_refs: {
            type: "array",
            description: "Optional spec refs this finding relates to.",
            items: { type: "string" },
            optional: true,
          },
          summary: "string",
          evidence_refs: {
            type: "array",
            description:
              "Files, commands, URLs, screenshots, or state paths supporting this finding.",
            items: { type: "string" },
            optional: true,
          },
          recommendation: {
            type: "string",
            description: "Recommended resolution: repair, spec_change, or accept_deviation.",
            enum: ["repair", "spec_change", "accept_deviation"],
          },
        },
        async ({
          audit_task_id,
          target_task_id,
          severity,
          spec_refs,
          summary,
          evidence_refs,
          recommendation,
        }) =>
          findings.recordFinding({
            audit_task_id: audit_task_id as string,
            target_task_id: target_task_id as string,
            severity: normalizeFindingSeverity(severity),
            spec_refs: normalizeStringList(spec_refs),
            summary: summary as string,
            evidence_refs: normalizeStringList(evidence_refs),
            recommendation: normalizeFindingRecommendation(recommendation),
          }),
        {
          label: "Record Finding",
          description:
            "Record a structured audit finding against an implementation task and optional spec refs.",
          estimate: "instant",
        },
      ),
    },
    items,
  };
}
