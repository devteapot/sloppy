import { describe, expect, test } from "bun:test";

import { parseApprovalsTree, parseTasksTree } from "../src/session/provider-mirrors";

describe("provider mirror parsing", () => {
  test("drops approvals that already include the local session in mirror lineage", () => {
    const approvals = parseApprovalsTree(
      "sloppy-session-parent",
      {
        id: "approvals",
        type: "collection",
        children: [
          {
            id: "approval-sloppy-session-child-approval-skills-approval-1",
            type: "item",
            properties: {
              status: "pending",
              provider: "sloppy-session-child",
              path: "/approvals/approval-skills-approval-1",
              action: "approve",
              reason: "Already mirrored through child.",
              mirror_lineage: ["sloppy-session-child", "skills"],
            },
            affordances: [{ action: "approve" }, { action: "reject" }],
          },
        ],
      },
      null,
      { localProviderIds: ["sloppy-session-child"] },
    );

    expect(approvals).toEqual([]);
  });

  test("infers legacy mirror lineage from nested mirrored approval ids", () => {
    const approvals = parseApprovalsTree(
      "sloppy-session-parent",
      {
        id: "approvals",
        type: "collection",
        children: [
          {
            id: "approval-sloppy-session-child-approval-skills-approval-1",
            type: "item",
            properties: {
              status: "pending",
              provider: "sloppy-session-child",
              path: "/approvals/approval-skills-approval-1",
              action: "approve",
              reason: "Legacy mirrored child approval.",
            },
            affordances: [{ action: "approve" }, { action: "reject" }],
          },
        ],
      },
      null,
      { localProviderIds: ["sloppy-session-child"] },
    );

    expect(approvals).toEqual([]);
  });

  test("preserves forwardable child-session approvals that have not looped back", () => {
    const approvals = parseApprovalsTree(
      "sloppy-session-child",
      {
        id: "approvals",
        type: "collection",
        children: [
          {
            id: "approval-skills-approval-1",
            type: "item",
            properties: {
              status: "pending",
              provider: "skills",
              path: "/skills/dual-model-development-loop",
              action: "skill_manage",
              reason: "Skill write requires approval.",
              mirror_lineage: ["skills"],
            },
            affordances: [{ action: "approve" }, { action: "reject" }],
          },
        ],
      },
      null,
      { localProviderIds: ["sloppy-session-parent"] },
    );

    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.provider).toBe("sloppy-session-child");
    expect(approvals[0]?.sourceApprovalId).toBe("approval-skills-approval-1");
    expect(approvals[0]?.mirrorLineage).toEqual(["sloppy-session-child", "skills"]);
  });

  test("drops tasks that already include the local session in mirror lineage", () => {
    const tasks = parseTasksTree(
      "sloppy-session-parent",
      {
        id: "tasks",
        type: "collection",
        children: [
          {
            id: "task-sloppy-session-child-task-terminal-task-1",
            type: "item",
            properties: {
              status: "running",
              provider: "sloppy-session-child",
              provider_task_id: "task-1",
              message: "Already mirrored through child.",
              mirror_lineage: ["sloppy-session-child", "terminal"],
            },
            affordances: [{ action: "cancel" }],
          },
        ],
      },
      { localProviderIds: ["sloppy-session-child"] },
    );

    expect(tasks).toEqual([]);
  });

  test("infers legacy mirror lineage from nested mirrored task ids", () => {
    const tasks = parseTasksTree(
      "sloppy-session-parent",
      {
        id: "tasks",
        type: "collection",
        children: [
          {
            id: "task-sloppy-session-child-task-terminal-task-1",
            type: "item",
            properties: {
              status: "running",
              provider_task_id: "task-1",
              message: "Legacy mirrored child task.",
            },
            affordances: [{ action: "cancel" }],
          },
        ],
      },
      { localProviderIds: ["sloppy-session-child"] },
    );

    expect(tasks).toEqual([]);
  });

  test("preserves forwardable child-session tasks and dedupes by mirrored id", () => {
    const tasks = parseTasksTree(
      "sloppy-session-child",
      {
        id: "tasks",
        type: "collection",
        children: [
          {
            id: "task-terminal-task-1",
            type: "item",
            properties: {
              status: "running",
              provider: "terminal",
              provider_task_id: "task-1",
              message: "First task update.",
              mirror_lineage: ["terminal"],
            },
            affordances: [{ action: "cancel" }],
          },
          {
            id: "duplicate-task-terminal-task-1",
            type: "item",
            properties: {
              status: "done",
              provider: "terminal",
              provider_task_id: "task-1",
              message: "Latest task update.",
              mirror_lineage: ["terminal"],
            },
          },
        ],
      },
      { localProviderIds: ["sloppy-session-parent"] },
    );

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.provider).toBe("sloppy-session-child");
    expect(tasks[0]?.providerTaskId).toBe("task-1");
    expect(tasks[0]?.status).toBe("completed");
    expect(tasks[0]?.message).toBe("Latest task update.");
    expect(tasks[0]?.mirrorLineage).toEqual(["sloppy-session-child", "terminal"]);
  });
});
