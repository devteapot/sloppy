import { action, type ItemDescriptor } from "@slop-ai/server";

import type { DescriptorWiring } from "./descriptor-wiring";
import { OPTIONAL_EXPECTED_VERSION_PARAM } from "./types";

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function commonRecordSchema() {
  return {
    project_id: {
      type: "string",
      description: "Optional project key. Defaults to local.",
      optional: true,
    },
    goal_id: {
      type: "string",
      description: "Optional goal id associated with this decision.",
      optional: true,
    },
    spec_version_at_creation: {
      type: "number",
      description: "Optional spec version current when this decision was created.",
      optional: true,
    },
    spec_sections_referenced: {
      type: "array",
      description: "Spec sections used as deterministic structural match keys.",
      items: { type: "string" },
    },
    code_areas: {
      type: "array",
      description: "Code areas used as deterministic structural match keys.",
      items: { type: "string" },
    },
    question: "string",
    canonical_summary: {
      type: "string",
      description: "Optional normalized summary. Defaults to a canonicalized question.",
      optional: true,
    },
    raised_by_role: {
      type: "string",
      description: "Role that raised the question.",
      enum: ["planner", "executor"],
      optional: true,
    },
    decided_by: {
      type: "string",
      description: "Who decided the resolution.",
      enum: ["user", "policy", "supervisor_agent"],
      optional: true,
    },
    answer: "string",
    reasoning: {
      type: "string",
      description: "Optional resolution rationale.",
      optional: true,
    },
    evidence_refs: {
      type: "array",
      description: "Optional evidence refs supporting the decision.",
      items: { type: "string" },
      optional: true,
    },
  } as const;
}

function matchSchema(questionClassEnum: readonly string[]) {
  return {
    project_id: {
      type: "string",
      description: "Optional project key. Defaults to local.",
      optional: true,
    },
    question_class: {
      type: "string",
      description: "Question class to match.",
      enum: questionClassEnum,
    },
    spec_sections_referenced: {
      type: "array",
      description: "Candidate spec sections.",
      items: { type: "string" },
    },
    code_areas: {
      type: "array",
      description: "Candidate code areas.",
      items: { type: "string" },
    },
    question: "string",
  } as const;
}

export function buildPrecedentsDescriptor(wiring: DescriptorWiring) {
  const { repo, precedents } = wiring;
  const precedentList = repo.listPrecedents();
  const caseList = repo.listCaseRecords();
  const items: ItemDescriptor[] = [
    ...precedentList.map(
      (precedent): ItemDescriptor => ({
        id: precedent.id,
        props: {
          kind: "precedent",
          ...precedent,
        },
        summary: `${precedent.context.question_class}: ${precedent.question.canonical_summary}`,
        actions: {
          record_precedent_use: action(
            {
              promoted: {
                type: "boolean",
                description:
                  "Whether this match was promoted into an auto-resolution. False records a near-miss/escalation.",
                optional: true,
              },
              expected_version: OPTIONAL_EXPECTED_VERSION_PARAM,
            },
            async ({ promoted, expected_version }) =>
              precedents.recordPrecedentUse({
                precedent_id: precedent.id,
                promoted: normalizeBoolean(promoted),
                expected_version:
                  typeof expected_version === "number" ? expected_version : undefined,
              }),
            {
              label: "Record Precedent Use",
              description: "Increment precedent use counters after a resolver considered it.",
              estimate: "instant",
            },
          ),
          contradict_precedent: action(
            {
              expected_version: OPTIONAL_EXPECTED_VERSION_PARAM,
            },
            async ({ expected_version }) =>
              precedents.contradictPrecedent({
                precedent_id: precedent.id,
                expected_version:
                  typeof expected_version === "number" ? expected_version : undefined,
              }),
            {
              label: "Contradict Precedent",
              description: "Mark this precedent contradicted so it cannot auto-apply.",
              estimate: "instant",
            },
          ),
        },
        meta: {
          salience:
            precedent.health.contradicted || precedent.health.invalidated_by !== undefined
              ? 0.25
              : 0.6,
        },
      }),
    ),
    ...caseList.map(
      (record): ItemDescriptor => ({
        id: record.id,
        props: {
          kind: "case_record",
          ...record,
        },
        summary: `${record.context.question_class}: ${record.question.canonical_summary}`,
        actions: {
          record_case_use: action(
            {
              expected_version: OPTIONAL_EXPECTED_VERSION_PARAM,
            },
            async ({ expected_version }) =>
              precedents.recordCaseUse({
                case_record_id: record.id,
                expected_version:
                  typeof expected_version === "number" ? expected_version : undefined,
              }),
            {
              label: "Record Case Use",
              description: "Increment case-record use counters after surfacing it to a resolver.",
              estimate: "instant",
            },
          ),
        },
        meta: {
          salience: 0.45,
        },
      }),
    ),
  ];

  return {
    type: "collection",
    props: {
      count: items.length,
      precedent_count: precedentList.length,
      active_precedent_count: precedentList.filter(
        (precedent) => !precedent.health.contradicted && !precedent.health.invalidated_by,
      ).length,
      case_record_count: caseList.length,
    },
    summary: `Precedents (${precedentList.length}) and case records (${caseList.length}).`,
    actions: {
      create_precedent: action(
        {
          ...commonRecordSchema(),
          question_class: {
            type: "string",
            description: "Precedent-eligible question class.",
            enum: ["lookup", "inference"],
          },
          expires_at: {
            type: "string",
            description:
              "Optional expiration timestamp. Inference precedents default to roughly 90 days.",
            optional: true,
          },
          embedding: {
            type: "array",
            description:
              "Optional semantic embedding for this question. If absent, a configured embedding provider may populate it.",
            items: { type: "number" },
            optional: true,
          },
        },
        async ({
          project_id,
          goal_id,
          spec_version_at_creation,
          question_class,
          spec_sections_referenced,
          code_areas,
          question,
          canonical_summary,
          embedding,
          raised_by_role,
          decided_by,
          answer,
          reasoning,
          evidence_refs,
          expires_at,
        }) =>
          precedents.createPrecedent({
            project_id,
            goal_id,
            spec_version_at_creation,
            question_class,
            spec_sections_referenced: normalizeStringList(spec_sections_referenced),
            code_areas: normalizeStringList(code_areas),
            question,
            canonical_summary,
            embedding,
            raised_by_role,
            decided_by,
            answer,
            reasoning,
            evidence_refs: normalizeStringList(evidence_refs),
            expires_at,
          }),
        {
          label: "Create Precedent",
          description: "Persist a lookup/inference resolution as a structurally matched precedent.",
          estimate: "instant",
        },
      ),
      create_case_record: action(
        {
          ...commonRecordSchema(),
          question_class: {
            type: "string",
            description: "Case-record question class.",
            enum: ["judgment", "conflict"],
          },
        },
        async ({
          project_id,
          goal_id,
          spec_version_at_creation,
          question_class,
          spec_sections_referenced,
          code_areas,
          question,
          canonical_summary,
          raised_by_role,
          decided_by,
          answer,
          reasoning,
          evidence_refs,
        }) =>
          precedents.createCaseRecord({
            project_id,
            goal_id,
            spec_version_at_creation,
            question_class,
            spec_sections_referenced: normalizeStringList(spec_sections_referenced),
            code_areas: normalizeStringList(code_areas),
            question,
            canonical_summary,
            raised_by_role,
            decided_by,
            answer,
            reasoning,
            evidence_refs: normalizeStringList(evidence_refs),
          }),
        {
          label: "Create Case Record",
          description: "Persist a judgment/conflict decision as resolver guidance, not automation.",
          estimate: "instant",
        },
      ),
      find_precedent_matches: action(
        matchSchema(["lookup", "inference"] as const),
        async ({ project_id, question_class, spec_sections_referenced, code_areas, question }) =>
          precedents.findPrecedentMatches({
            project_id,
            question_class,
            spec_sections_referenced: normalizeStringList(spec_sections_referenced),
            code_areas: normalizeStringList(code_areas),
            question,
          }),
        {
          label: "Find Precedent Matches",
          description: "Find active lookup/inference precedents using deterministic keys.",
          estimate: "instant",
        },
      ),
      find_case_record_matches: action(
        matchSchema(["judgment", "conflict"] as const),
        async ({ project_id, question_class, spec_sections_referenced, code_areas, question }) =>
          precedents.findCaseRecordMatches({
            project_id,
            question_class,
            spec_sections_referenced: normalizeStringList(spec_sections_referenced),
            code_areas: normalizeStringList(code_areas),
            question,
          }),
        {
          label: "Find Case Records",
          description: "Surface structurally similar judgment/conflict case records.",
          estimate: "instant",
        },
      ),
      invalidate_precedents: action(
        {
          spec_revision_id: "string",
          spec_sections_referenced: {
            type: "array",
            description: "Spec sections revised by this spec change.",
            items: { type: "string" },
          },
        },
        async ({ spec_revision_id, spec_sections_referenced }) =>
          precedents.invalidatePrecedents({
            spec_revision_id,
            spec_sections_referenced: normalizeStringList(spec_sections_referenced),
          }),
        {
          label: "Invalidate Precedents",
          description: "Mark precedents overlapping revised spec sections as stale.",
          estimate: "instant",
        },
      ),
    },
    items,
    meta: {
      salience: precedentList.some(
        (precedent) => !precedent.health.contradicted && !precedent.health.invalidated_by,
      )
        ? 0.65
        : 0.35,
    },
  };
}
