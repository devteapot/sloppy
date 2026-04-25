import { action, type ItemDescriptor } from "@slop-ai/server";

import type { DescriptorWiring } from "./descriptor-wiring";

export function buildGoalsDescriptor(wiring: DescriptorWiring) {
  const { repo, goals } = wiring;
  const items: ItemDescriptor[] = repo.listGoals().map((goal) => {
    const revisions = repo.loadGoalRevisions(goal.id);
    return {
      id: goal.id,
      props: {
        ...goal,
        revision_count: revisions.length,
      },
      summary: `${goal.status}: ${goal.title}`,
      actions: {
        revise_goal: action(
          {
            title: {
              type: "string",
              description: "Optional revised goal title.",
              optional: true,
            },
            intent: {
              type: "string",
              description: "Optional revised goal intent.",
              optional: true,
            },
            magnitude: {
              type: "string",
              description: "Revision magnitude: minor or material.",
              enum: ["minor", "material"],
              optional: true,
            },
            reason: {
              type: "string",
              description: "Optional reason for the revision.",
              optional: true,
            },
            evidence_refs: {
              type: "array",
              description: "Optional evidence refs supporting the revision.",
              items: { type: "string" },
              optional: true,
            },
          },
          async ({ title, intent, magnitude, reason, evidence_refs }) =>
            goals.reviseGoal({
              goal_id: goal.id,
              title: typeof title === "string" ? title : undefined,
              intent: typeof intent === "string" ? intent : undefined,
              magnitude: magnitude === "minor" ? "minor" : "material",
              reason: typeof reason === "string" ? reason : undefined,
              evidence_refs: Array.isArray(evidence_refs)
                ? evidence_refs.filter((item): item is string => typeof item === "string")
                : undefined,
            }),
          {
            label: "Revise Goal",
            description: "Write a new versioned goal revision.",
            estimate: "instant",
          },
        ),
        propose_goal_revision: action(
          {
            title: {
              type: "string",
              description: "Optional revised goal title.",
              optional: true,
            },
            intent: {
              type: "string",
              description: "Optional revised goal intent.",
              optional: true,
            },
            magnitude: {
              type: "string",
              description: "Revision magnitude: minor or material.",
              enum: ["minor", "material"],
            },
            reason: "string",
            evidence_refs: {
              type: "array",
              description: "Optional evidence refs supporting the revision.",
              items: { type: "string" },
              optional: true,
            },
          },
          async ({ title, intent, magnitude, reason, evidence_refs }) =>
            goals.proposeGoalRevision({
              goal_id: goal.id,
              title: typeof title === "string" ? title : undefined,
              intent: typeof intent === "string" ? intent : undefined,
              magnitude: magnitude === "minor" ? "minor" : "material",
              reason: reason as string,
              evidence_refs: Array.isArray(evidence_refs)
                ? evidence_refs.filter((item): item is string => typeof item === "string")
                : undefined,
            }),
          {
            label: "Propose Goal Revision",
            description:
              "Write a GoalRevision protocol message and open/apply the matching goal_accept gate.",
            estimate: "instant",
          },
        ),
        accept_goal: action(async () => goals.requestGoalAcceptance(goal.id), {
          label: "Accept Goal",
          description:
            "Open a user-resolved goal_accept gate for the current goal version. The accepted gate applies the transition.",
          estimate: "instant",
        }),
        archive_goal: action(async () => goals.archiveGoal(goal.id), {
          label: "Archive Goal",
          description: "Archive this goal.",
          dangerous: true,
          estimate: "instant",
        }),
      },
      children: {
        revisions: {
          type: "collection",
          props: { count: revisions.length },
          summary: "Versioned goal revisions.",
          items: revisions.map((revision) => ({
            id: String(revision.version),
            props: revision,
            summary: `v${revision.version}: ${revision.title}`,
          })),
        },
      },
      meta: {
        salience: goal.status === "accepted" ? 0.9 : 0.7,
      },
    };
  });

  return {
    type: "collection",
    props: {
      count: items.length,
      accepted: repo.listGoals().filter((goal) => goal.status === "accepted").length,
    },
    summary: `Goals (${items.length}).`,
    actions: {
      create_goal: action(
        {
          title: "string",
          intent: "string",
        },
        async ({ title, intent }) =>
          goals.createGoal({
            title: title as string,
            intent: intent as string,
          }),
        {
          label: "Create Goal",
          description: "Create a versioned goal artifact.",
          estimate: "instant",
        },
      ),
    },
    items,
    meta: {
      salience: 0.85,
    },
  };
}
