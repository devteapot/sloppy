import { describe, expect, test } from "bun:test";

import type { SloppyConfig } from "../src/config/schema";
import type { ProviderRuntimeHub } from "../src/core/hub";
import { RoleRegistry, type RuntimeContext } from "../src/core/role";
import { createOrchestratorRole, plannerRole, specAgentRole } from "../src/runtime/orchestration";
import { attachOrchestrationRuntime } from "../src/runtime/orchestration/attach";
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

    const transformed = role.transformInvoke?.(
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

    const tasks = transformed?.tasks as Array<{ client_ref: string; depends_on?: string[] }>;
    const ui = tasks.find((task) => task.client_ref === "ui");
    const verification = tasks.find((task) => task.client_ref === "verification");
    expect(ui?.depends_on).toEqual(["scaffold"]);
    expect([...(verification?.depends_on ?? [])].sort()).toEqual(["scaffold", "ui"].sort());
  });

  test("leaves unrelated affordances untouched", () => {
    const role = createOrchestratorRole();
    const params = { foo: "bar", tasks: [{ name: "n", goal: "g" }] };
    const transformed = role.transformInvoke?.(
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

describe("autonomous specialist role prompts", () => {
  test("spec-agent prompt requires a single structured spec creation output and recovery on invalid submissions", () => {
    const prompt = specAgentRole.systemPromptFragment?.({} as never) ?? "";

    expect(prompt).toContain("Output contract");
    expect(prompt).toContain("Exactly one final artifact");
    expect(prompt).toContain("/specs.create_spec");
    expect(prompt).toContain("goal_id");
    expect(prompt).toContain("If any /specs call is rejected");
  });

  test("planner prompt requires a complete plan revision and recovery on invalid submissions", () => {
    const prompt = plannerRole.systemPromptFragment?.({} as never) ?? "";

    expect(prompt).toContain("Output contract");
    expect(prompt).toContain("Exactly one final artifact");
    expect(prompt).toContain("/orchestration.create_plan_revision");
    expect(prompt).toContain("complete slice set");
    expect(prompt).toContain("If create_plan_revision is rejected");
  });
});

describe("orchestration runtime roles", () => {
  test("registers orchestrator, spec-agent, planner, and executor role factories", () => {
    const registry = new RoleRegistry();
    const hub = {
      addPolicyRule: () => undefined,
    } as unknown as ProviderRuntimeHub;
    const ctx: RuntimeContext = {
      hub,
      config: {} as SloppyConfig,
      publishEvent: () => undefined,
      roleRegistry: registry,
    };

    const attached = attachOrchestrationRuntime(hub, {} as SloppyConfig, ctx);
    try {
      expect(registry.resolve("orchestrator", ctx)?.id).toBe("orchestrator");
      expect(registry.resolve("spec-agent", ctx)?.id).toBe("spec-agent");
      expect(registry.resolve("planner", ctx)?.id).toBe("planner");
      expect(registry.resolve("executor", ctx)?.id).toBe("executor");
    } finally {
      attached.stop();
    }

    expect(registry.has("orchestrator")).toBe(false);
    expect(registry.has("spec-agent")).toBe(false);
    expect(registry.has("planner")).toBe(false);
    expect(registry.has("executor")).toBe(false);
  });

  test("attach runtime starts the autonomous goal coordinator when orchestration, delegation, and specs are enabled", async () => {
    const registry = new RoleRegistry();
    const watchedPaths: string[] = [];
    let stopped = 0;
    const hub = {
      addPolicyRule: () => undefined,
      watchPath: async (providerId: string, path: string) => {
        watchedPaths.push(`${providerId}:${path}`);
        return () => {
          stopped += 1;
        };
      },
    } as unknown as ProviderRuntimeHub;
    const ctx: RuntimeContext = {
      hub,
      config: {} as SloppyConfig,
      publishEvent: () => undefined,
      roleRegistry: registry,
    };
    const config = {
      providers: {
        builtin: {
          orchestration: true,
          delegation: true,
          spec: true,
        },
      },
    } as SloppyConfig;

    const attached = attachOrchestrationRuntime(hub, config, ctx);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(watchedPaths).toContain("orchestration:/goals");
    expect(watchedPaths).toContain("orchestration:/gates");
    expect(watchedPaths).toContain("spec:/specs");

    attached.stop();
    expect(stopped).toBe(3);
  });
});
