#!/usr/bin/env bun
// Generates demo orchestration state + events.jsonl so the dashboard has
// something to animate without running a full sloppy session.
// Usage: bun apps/dashboard/demo.ts [--out <dir>]

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const outFlag = Bun.argv.indexOf("--out");
const outDir = resolve(outFlag >= 0 ? (Bun.argv[outFlag + 1] ?? ".sloppy-demo") : ".sloppy-demo");
const orchestrationDir = join(outDir, ".sloppy/orchestration");
const tasksDir = join(orchestrationDir, "tasks");
const digestsDir = join(orchestrationDir, "digests");
mkdirSync(tasksDir, { recursive: true });
mkdirSync(digestsDir, { recursive: true });

const now = Date.now();
const iso = (offsetMs = 0) => new Date(now + offsetMs).toISOString();

const tasks = [
  {
    id: "analyze",
    name: "Analyze requirements",
    goal: "Read spec and identify components",
    depends_on: [] as string[],
    status: "completed",
  },
  {
    id: "backend",
    name: "Build backend",
    goal: "Implement API endpoints and storage",
    depends_on: ["analyze"],
    status: "running",
  },
  {
    id: "frontend",
    name: "Build frontend",
    goal: "Scaffold UI and wire to API",
    depends_on: ["analyze"],
    status: "running",
  },
  {
    id: "docs",
    name: "Write docs",
    goal: "Produce README and API reference",
    depends_on: ["backend", "frontend"],
    status: "pending",
  },
];

writeFileSync(
  join(orchestrationDir, "plan.json"),
  JSON.stringify(
    {
      session_id: "demo",
      query: "Build a small todo app with REST API and docs",
      strategy: "parallel",
      status: "active",
      max_agents: 3,
      created_at: iso(-120_000),
      version: 4,
    },
    null,
    2,
  ),
);

for (const [idx, t] of tasks.entries()) {
  const dir = join(tasksDir, t.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "definition.json"),
    JSON.stringify(
      {
        name: t.name,
        goal: t.goal,
        depends_on: t.depends_on,
        created_at: iso(-120_000 + idx * 2000),
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify(
      {
        status: t.status,
        iteration: t.status === "running" ? 3 : t.status === "completed" ? 5 : 0,
        version: 2,
        updated_at: iso(-5_000),
        completed_at: t.status === "completed" ? iso(-30_000) : undefined,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, "progress.md"),
    t.status === "pending" ? "" : `Progress for ${t.name}\n- step 1 done\n- step 2 in flight`,
  );
}

writeFileSync(
  join(digestsDir, "digest-demo.json"),
  JSON.stringify(
    {
      id: "digest-demo",
      cadence: "manual",
      status: "blocked",
      session_id: "demo",
      plan_id: "demo-plan",
      headline: [
        "Plan is blocked on one spec acceptance gate.",
        "1/4 slices complete; 2 active; 0 failed.",
        "Criteria coverage: 2/6 satisfied; 4 unknown.",
      ],
      sections: {
        escalations: [
          {
            gate_id: "gate-demo",
            gate_type: "spec_accept",
            status: "open",
            subject_ref: "spec:demo",
            summary: "Review and accept the current demo spec before scheduling docs.",
            evidence_refs: ["spec:demo@1"],
            created_at: iso(-10_000),
          },
        ],
        auto_resolutions: { count: 1, high_confidence_count: 1, entries: [] },
        near_misses: [
          {
            kind: "failed_slice",
            ref: "slice:frontend",
            summary: "Frontend slice retried after a CAS conflict.",
            created_at: iso(-4_000),
          },
        ],
        drift_dashboard: {
          progress: {
            criteria_total: 6,
            criteria_satisfied: 2,
            criteria_unknown: 4,
            prior_distance: 5,
            current_distance: 4,
            velocity: 1,
          },
          coherence: {
            replan_count: 1,
            spec_revision_count: 1,
            question_density: 1,
            failure_count: 0,
            thresholds: {},
            breaches: [],
          },
          intent: {
            coverage_gap_count: 1,
            off_plan_slice_count: 0,
            goal_revision_pressure: 0,
            minor_goal_revision_count: 0,
            material_goal_revision_count: 0,
          },
          recent_events: [
            {
              id: "drift-demo",
              kind: "coverage_gap",
              severity: "warning",
              status: "open",
              subject_ref: "slice:frontend",
              summary: "UI files changed before a criterion was mapped.",
              created_at: iso(-8_000),
            },
          ],
        },
        budget: {
          configured: true,
          exceeded: false,
          exceeded_limits: [],
          message: "Within configured budget.",
        },
        whats_next: {
          pending_gate_count: 1,
          next_ready_slices: ["docs"],
          running_slices: ["backend", "frontend"],
          final_audit_status: "none",
        },
        what_changed: {
          slices: {
            total: 4,
            pending: 1,
            scheduled: 0,
            running: 2,
            verifying: 0,
            completed: 1,
            failed: 0,
            cancelled: 0,
            superseded: 0,
          },
          plan_revisions: { total: 1, proposed: 0, accepted: 1, rejected: 0, superseded: 0 },
          audits: { total: 0, passed: 0, failed: 0, latest_status: "none" },
          protocol_messages: { total: 1, open: 1 },
        },
      },
      actions: [
        {
          id: "action-gate-demo-accept",
          kind: "accept_gate",
          label: "Accept spec_accept",
          target_ref: "gate:gate-demo",
          action_path: "/gates/gate-demo",
          action_name: "resolve_gate",
          params: { status: "accepted" },
          source_refs: ["gate:gate-demo"],
          urgency: "high",
        },
      ],
      delivery: { pull_ref: "digest:digest-demo", push_required: false, push_reasons: [] },
      source_refs: ["plan:demo-plan", "gate:gate-demo", "drift:drift-demo", "slice:frontend"],
      created_at: iso(-2_000),
    },
    null,
    2,
  ),
);

// Events stream
const events: string[] = [];
const emit = (offsetMs: number, actor: Record<string, unknown>, rest: Record<string, unknown>) => {
  events.push(
    JSON.stringify({
      ts: iso(offsetMs),
      actor,
      ...rest,
    }),
  );
};

const orch = { id: "orchestrator", name: "Orchestrator", kind: "orchestrator" };
const agentA = {
  id: "sub-agent-a",
  name: "Backend worker",
  kind: "agent",
  parentId: "orchestrator",
  taskId: "backend",
};
const agentB = {
  id: "sub-agent-b",
  name: "Frontend worker",
  kind: "agent",
  parentId: "orchestrator",
  taskId: "frontend",
};
const agentC = {
  id: "sub-agent-c",
  name: "Analyst",
  kind: "agent",
  parentId: "orchestrator",
  taskId: "analyze",
};

// Orchestrator sets up
emit(-90_000, orch, {
  kind: "tool_completed",
  toolUseId: "t0",
  providerId: "orchestration",
  action: "create_plan",
  path: "/orchestration",
  status: "ok",
  summary: "plan created",
});

// Analyst reads spec
for (let i = 0; i < 3; i++) {
  const t = -80_000 + i * 1500;
  emit(t, agentC, {
    kind: "tool_started",
    toolUseId: `a${i}`,
    providerId: "filesystem",
    action: "read",
    path: "/workspace",
    invocationKind: "affordance",
    file: { op: "read", path: `docs/spec-${i}.md` },
  });
  emit(t + 500, agentC, {
    kind: "tool_completed",
    toolUseId: `a${i}`,
    providerId: "filesystem",
    action: "read",
    path: "/workspace",
    status: "ok",
    summary: `read spec-${i}.md`,
    file: { op: "read", path: `docs/spec-${i}.md` },
  });
}

// Backend writes api files
const backendFiles = ["src/api/users.ts", "src/api/todos.ts", "src/api/index.ts", "src/db.ts"];
backendFiles.forEach((path, i) => {
  const t = -55_000 + i * 3000;
  emit(t, agentA, {
    kind: "tool_started",
    toolUseId: `ba${i}`,
    providerId: "filesystem",
    action: "write",
    path: "/workspace",
    invocationKind: "affordance",
    file: { op: "write", path },
  });
  emit(t + 800, agentA, {
    kind: "tool_completed",
    toolUseId: `ba${i}`,
    providerId: "filesystem",
    action: "write",
    path: "/workspace",
    status: "ok",
    summary: `wrote ${path}`,
    file: { op: "write", path },
  });
});

// Frontend reads backend files (data flow)
backendFiles.slice(0, 2).forEach((path, i) => {
  const t = -30_000 + i * 2500;
  emit(t, agentB, {
    kind: "tool_started",
    toolUseId: `fb${i}`,
    providerId: "filesystem",
    action: "read",
    path: "/workspace",
    invocationKind: "affordance",
    file: { op: "read", path },
  });
  emit(t + 600, agentB, {
    kind: "tool_completed",
    toolUseId: `fb${i}`,
    providerId: "filesystem",
    action: "read",
    path: "/workspace",
    status: "ok",
    summary: `read ${path}`,
    file: { op: "read", path },
  });
});

// Frontend writes UI files
const frontendFiles = ["src/ui/app.tsx", "src/ui/todo.tsx", "src/ui/main.tsx"];
frontendFiles.forEach((path, i) => {
  const t = -22_000 + i * 3000;
  emit(t, agentB, {
    kind: "tool_started",
    toolUseId: `fw${i}`,
    providerId: "filesystem",
    action: "write",
    path: "/workspace",
    invocationKind: "affordance",
    file: { op: "write", path },
  });
  emit(t + 700, agentB, {
    kind: "tool_completed",
    toolUseId: `fw${i}`,
    providerId: "filesystem",
    action: "write",
    path: "/workspace",
    status: "ok",
    summary: `wrote ${path}`,
    file: { op: "write", path },
  });
});

// Backend: in-flight tool + one error + approval
emit(-6_000, agentA, {
  kind: "tool_started",
  toolUseId: "bax",
  providerId: "filesystem",
  action: "write",
  path: "/workspace",
  invocationKind: "affordance",
  file: { op: "write", path: "src/api/auth.ts" },
});
emit(-2_500, agentA, {
  kind: "tool_approval_requested",
  toolUseId: "bap",
  providerId: "filesystem",
  action: "write",
  path: "/workspace",
  errorCode: "approval_required",
});
emit(-4_000, agentB, {
  kind: "tool_completed",
  toolUseId: "fbe",
  providerId: "filesystem",
  action: "write",
  path: "/workspace",
  status: "error",
  errorCode: "CAS_CONFLICT",
  summary: "version mismatch",
  file: { op: "write", path: "src/ui/app.tsx" },
});

writeFileSync(join(outDir, ".sloppy/events.jsonl"), `${events.join("\n")}\n`);

console.log(`Demo state written to ${outDir}`);
console.log(`  orchestration: ${orchestrationDir}`);
console.log(`  events: ${join(outDir, ".sloppy/events.jsonl")}`);
console.log(`  Start the dashboard with: bun apps/dashboard/server.ts --workspace ${outDir}`);
