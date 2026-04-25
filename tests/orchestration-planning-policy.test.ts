import { describe, expect, test } from "bun:test";

import { createOrchestratorRole } from "../src/runtime/orchestration";
import { inferBatchDependencyRefs } from "../src/runtime/orchestration/planning-policy";

describe("planning-policy.inferBatchDependencyRefs", () => {
  test("infers conservative coding-DAG edges (scaffold -> producers, docs/verification last)", () => {
    const drafts = [
      {
        id: "docs",
        name: "Create README with setup and run instructions",
        goal: "Create README.md with setup instructions.",
        client_ref: "docs",
      },
      {
        id: "ui",
        name: "Build UI components: board, columns, task cards",
        goal: "Implement React UI components for the task board.",
        client_ref: "ui",
      },
      {
        id: "scaffold",
        name: "Scaffold Vite React + Tailwind project",
        goal: "Create a Vite React TypeScript project structure with Tailwind CSS.",
        client_ref: "scaffold",
      },
      {
        id: "verification",
        name: "Verify build passes",
        goal: "Run npm run build in the project.",
        client_ref: "verification",
      },
      {
        id: "data-model",
        name: "Task board data model and seed data",
        goal: "Create the task board data model, seed data, and store/context.",
        client_ref: "data-model",
      },
    ];

    const inferred = inferBatchDependencyRefs(drafts);
    expect(inferred.get("scaffold")).toEqual([]);
    expect(inferred.get("data-model")).toEqual(["scaffold"]);
    expect(inferred.get("ui")).toEqual(["scaffold"]);
    expect([...(inferred.get("docs") ?? [])].sort()).toEqual(
      ["data-model", "scaffold", "ui"].sort(),
    );
    expect([...(inferred.get("verification") ?? [])].sort()).toEqual(
      ["data-model", "scaffold", "ui"].sort(),
    );
  });

  test("does not invent edges for non-coding plans", () => {
    const drafts = [
      {
        id: "research",
        name: "research competitors",
        goal: "Collect competitor notes.",
        client_ref: "research",
      },
      {
        id: "summary",
        name: "draft docs summary",
        goal: "Write a docs-style summary of the findings.",
        client_ref: "summary",
      },
    ];

    const inferred = inferBatchDependencyRefs(drafts);
    expect(inferred.get("research")).toEqual([]);
    expect(inferred.get("summary")).toEqual([]);
  });

  test("preserves explicit depends_on without duplicating", () => {
    const drafts = [
      { id: "a", name: "scaffold", goal: "scaffold project", client_ref: "a" },
      {
        id: "b",
        name: "ui-card",
        goal: "build cards",
        client_ref: "b",
        depends_on: ["a"],
      },
    ];

    const inferred = inferBatchDependencyRefs(drafts);
    expect(inferred.get("a")).toEqual([]);
    expect(inferred.get("b")).toEqual(["a"]);
  });
});

describe("orchestrator role transformInvoke", () => {
  test("rewrites create_tasks params with inferred edges referencing client_ref", () => {
    const role = createOrchestratorRole();
    expect(typeof role.transformInvoke).toBe("function");

    const transformed = role.transformInvoke!(
      {
        kind: "affordance",
        providerId: "orchestration",
        action: "create_tasks",
        path: "/",
        dangerous: false,
      },
      {
        tasks: [
          { name: "scaffold-app", client_ref: "scaffold", goal: "scaffold the project" },
          { name: "ui-board", client_ref: "ui", goal: "build ui components" },
          { name: "verify build", client_ref: "verification", goal: "verify build passes" },
        ],
      },
      {} as never,
    );

    const tasks = (transformed.tasks as Array<{ client_ref: string; depends_on?: string[] }>);
    const ui = tasks.find((task) => task.client_ref === "ui");
    const verification = tasks.find((task) => task.client_ref === "verification");
    expect(ui?.depends_on).toEqual(["scaffold"]);
    expect([...(verification?.depends_on ?? [])].sort()).toEqual(["scaffold", "ui"].sort());
  });

  test("leaves unrelated affordances untouched", () => {
    const role = createOrchestratorRole();
    const params = { foo: "bar", tasks: [{ name: "n", goal: "g" }] };
    const transformed = role.transformInvoke!(
      {
        kind: "affordance",
        providerId: "orchestration",
        action: "create_task",
        path: "/",
        dangerous: false,
      },
      params,
      {} as never,
    );
    expect(transformed).toBe(params);
  });
});
