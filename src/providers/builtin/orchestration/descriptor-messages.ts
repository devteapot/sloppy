import { action, type ItemDescriptor } from "@slop-ai/server";

import type { DescriptorWiring } from "./descriptor-wiring";

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

export function buildMessagesDescriptor(wiring: DescriptorWiring) {
  const { repo, messages } = wiring;
  const messageList = repo.listMessages();
  const items: ItemDescriptor[] = messageList.map((message) => ({
    id: message.id,
    props: message,
    summary: `${message.kind}: ${message.summary}`,
    meta: {
      salience: message.status === "open" ? 0.75 : 0.35,
    },
  }));

  return {
    type: "collection",
    props: {
      count: items.length,
      open: messageList.filter((message) => message.status === "open").length,
    },
    summary: `Protocol messages (${items.length}).`,
    actions: {
      submit_protocol_message: action(
        {
          kind: {
            type: "string",
            description:
              "Message kind: SpecQuestion, SpecRevisionProposal, PlanRevisionProposal, EscalationRequest, EvidenceClaim, or GoalRevision.",
            enum: [
              "SpecQuestion",
              "SpecRevisionProposal",
              "PlanRevisionProposal",
              "EscalationRequest",
              "EvidenceClaim",
              "GoalRevision",
            ],
          },
          from_role: {
            type: "string",
            description: "Sender role.",
            enum: ["user", "resolver", "spec-agent", "planner", "executor", "orchestrator"],
          },
          to_role: {
            type: "string",
            description: "Receiver role.",
            enum: ["user", "resolver", "spec-agent", "planner", "executor", "orchestrator"],
          },
          summary: "string",
          body: {
            type: "string",
            description: "Optional message body.",
            optional: true,
          },
          artifact_refs: {
            type: "array",
            description: "Optional artifact refs.",
            items: { type: "string" },
            optional: true,
          },
          evidence_refs: {
            type: "array",
            description: "Optional evidence refs.",
            items: { type: "string" },
            optional: true,
          },
          question_class: {
            type: "string",
            description: "Optional SpecQuestion class: lookup, inference, judgment, or conflict.",
            enum: ["lookup", "inference", "judgment", "conflict"],
            optional: true,
          },
          project_id: {
            type: "string",
            description: "Optional project key for SpecQuestion precedent matching.",
            optional: true,
          },
          goal_id: {
            type: "string",
            description: "Optional goal id for SpecQuestion provenance.",
            optional: true,
          },
          spec_version_at_creation: {
            type: "number",
            description: "Optional spec version current when the SpecQuestion was raised.",
            optional: true,
          },
          spec_sections_referenced: {
            type: "array",
            description: "Spec sections used as deterministic SpecQuestion match keys.",
            items: { type: "string" },
            optional: true,
          },
          code_areas: {
            type: "array",
            description: "Code areas used as deterministic SpecQuestion match keys.",
            items: { type: "string" },
            optional: true,
          },
          auto_resolve_with_precedent: {
            type: "boolean",
            description:
              "When true, lookup/inference SpecQuestions may resolve from a high-confidence precedent.",
            optional: true,
          },
        },
        async ({
          kind,
          from_role,
          to_role,
          summary,
          body,
          artifact_refs,
          evidence_refs,
          question_class,
          project_id,
          goal_id,
          spec_version_at_creation,
          spec_sections_referenced,
          code_areas,
          auto_resolve_with_precedent,
        }) =>
          messages.submitMessage({
            kind,
            from_role,
            to_role,
            summary: summary as string,
            body: typeof body === "string" ? body : undefined,
            artifact_refs: normalizeStringList(artifact_refs),
            evidence_refs: normalizeStringList(evidence_refs),
            question_class,
            project_id,
            goal_id,
            spec_version_at_creation,
            spec_sections_referenced: normalizeStringList(spec_sections_referenced),
            code_areas: normalizeStringList(code_areas),
            auto_resolve_with_precedent,
          }),
        {
          label: "Submit Protocol Message",
          description: "Append a typed inter-role protocol message.",
          estimate: "instant",
        },
      ),
    },
    items,
    meta: {
      salience: messageList.some((message) => message.status === "open") ? 0.75 : 0.4,
    },
  };
}
