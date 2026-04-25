import { action, type ItemDescriptor } from "@slop-ai/server";

import type { DescriptorWiring } from "./descriptor-wiring";
import {
  type GateResolver,
  type GateStatus,
  type GateType,
  OPTIONAL_EXPECTED_VERSION_PARAM,
} from "./types";

function normalizeGateType(value: unknown): GateType {
  switch (value) {
    case "goal_accept":
    case "spec_accept":
    case "plan_accept":
    case "slice_gate":
    case "irreversible_action":
    case "budget_exceeded":
    case "drift_escalation":
      return value;
    default:
      return "irreversible_action";
  }
}

function normalizeResolver(value: unknown): GateResolver | undefined {
  return value === "policy" || value === "user" ? value : undefined;
}

function normalizeResolutionStatus(value: unknown): Exclude<GateStatus, "open"> {
  switch (value) {
    case "rejected":
    case "cancelled":
      return value;
    default:
      return "accepted";
  }
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

export function buildGatesDescriptor(wiring: DescriptorWiring) {
  const { repo, gates } = wiring;
  const gateList = repo.listGates();
  const items: ItemDescriptor[] = gateList.map((gate) => ({
    id: gate.id,
    props: gate,
    summary: `${gate.status}: ${gate.gate_type} for ${gate.subject_ref}`,
    actions: {
      ...(gate.status === "open"
        ? {
            resolve_gate: action(
              {
                status: {
                  type: "string",
                  description: "Gate resolution: accepted, rejected, or cancelled.",
                  enum: ["accepted", "rejected", "cancelled"],
                },
                resolution: {
                  type: "string",
                  description: "Optional rationale for the resolution.",
                  optional: true,
                },
                expected_version: OPTIONAL_EXPECTED_VERSION_PARAM,
              },
              async ({ status, resolution, expected_version }) =>
                gates.resolveGate({
                  gate_id: gate.id,
                  status: normalizeResolutionStatus(status),
                  resolution: typeof resolution === "string" ? resolution : undefined,
                  expected_version:
                    typeof expected_version === "number" ? expected_version : undefined,
                }),
              {
                label: "Resolve Gate",
                description: "Resolve this orchestration decision gate.",
                estimate: "instant",
              },
            ),
          }
        : {}),
    },
    meta: {
      salience: gate.status === "open" ? 0.95 : 0.4,
      urgency: gate.status === "open" ? "high" : "low",
    },
  }));

  return {
    type: "collection",
    props: {
      count: items.length,
      open: gateList.filter((gate) => gate.status === "open").length,
    },
    summary: `Decision gates (${items.length}).`,
    actions: {
      open_gate: action(
        {
          gate_type: {
            type: "string",
            description:
              "Gate type: goal_accept, spec_accept, plan_accept, slice_gate, irreversible_action, or budget_exceeded.",
            enum: [
              "goal_accept",
              "spec_accept",
              "plan_accept",
              "slice_gate",
              "irreversible_action",
              "budget_exceeded",
              "drift_escalation",
            ],
          },
          scope: {
            type: "string",
            description: "Optional policy scope for this gate.",
            optional: true,
          },
          resolver: {
            type: "string",
            description: "Resolver for this gate. HITL uses user.",
            enum: ["user", "policy"],
            optional: true,
          },
          subject_ref: "string",
          summary: "string",
          evidence_refs: {
            type: "array",
            description: "Optional evidence refs supporting this gate.",
            items: { type: "string" },
            optional: true,
          },
        },
        async ({ gate_type, scope, resolver, subject_ref, summary, evidence_refs }) =>
          gates.openGate({
            gate_type: normalizeGateType(gate_type),
            scope: typeof scope === "string" ? scope : undefined,
            resolver: normalizeResolver(resolver),
            subject_ref: subject_ref as string,
            summary: summary as string,
            evidence_refs: normalizeStringList(evidence_refs),
          }),
        {
          label: "Open Gate",
          description: "Open a generic orchestration gate.",
          estimate: "instant",
        },
      ),
    },
    items,
    meta: {
      salience: gateList.some((gate) => gate.status === "open") ? 0.95 : 0.5,
    },
  };
}
