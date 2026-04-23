import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import { debug } from "../../core/debug";

type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

type TaskDefinition = {
  id: string;
  name: string;
  goal: string;
  depends_on: string[];
  created_at: string;
};

type TaskState = {
  status: TaskStatus;
  updated_at: string;
  iteration: number;
  message?: string;
  error?: string;
  completed_at?: string;
  version?: number;
};

type Plan = {
  session_id: string;
  query: string;
  strategy: string;
  max_agents: number;
  created_at: string;
  status: "active" | "completed" | "cancelled";
  version?: number;
};

type HandoffStatus = "pending" | "responded" | "cancelled";

type Handoff = {
  id: string;
  from_task: string;
  to_task: string;
  request: string;
  status: HandoffStatus;
  created_at: string;
  responded_at?: string;
  response?: string;
  version?: number;
};

const ORCHESTRATION_DIR = ".sloppy/orchestration";

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): number {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return statSync(path).mtimeMs;
}

function appendText(path: string, text: string): number {
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${existing}${sep}${text}\n`, "utf8");
  return statSync(path).mtimeMs;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 16)}\n...[truncated]`;
}

export interface OrchestrationProviderOptions {
  workspaceRoot: string;
  sessionId?: string;
  progressTailMaxChars?: number;
}

export class OrchestrationProvider {
  readonly server: SlopServer;
  private root: string;
  private sessionId: string;
  private progressTailMaxChars: number;
  private planVersions = new Map<string, number>();
  private taskVersions = new Map<string, number>();
  private handoffVersions = new Map<string, number>();

  constructor(options: OrchestrationProviderOptions) {
    this.root = resolve(options.workspaceRoot, ORCHESTRATION_DIR);
    this.sessionId = options.sessionId ?? "default";
    this.progressTailMaxChars = options.progressTailMaxChars ?? 2048;

    mkdirSync(this.root, { recursive: true });
    mkdirSync(join(this.root, "tasks"), { recursive: true });
    mkdirSync(join(this.root, "handoffs"), { recursive: true });

    this.hydrateVersionsFromDisk();
    debug("orchestration", "hydrate", {
      plans: this.planVersions.size,
      tasks: this.taskVersions.size,
      handoffs: this.handoffVersions.size,
    });

    this.server = createSlopServer({
      id: "orchestration",
      name: "Orchestration",
    });

    this.server.register("orchestration", () => this.buildRootDescriptor());
    this.server.register("tasks", () => this.buildTasksDescriptor());
    this.server.register("handoffs", () => this.buildHandoffsDescriptor());
  }

  stop(): void {
    this.server.stop();
  }

  private planPath(): string {
    return join(this.root, "plan.json");
  }

  private taskDir(taskId: string): string {
    return join(this.root, "tasks", taskId);
  }

  private loadPlan(): Plan | null {
    return readJson<Plan>(this.planPath());
  }

  private loadTaskDefinition(taskId: string): TaskDefinition | null {
    return readJson<TaskDefinition>(join(this.taskDir(taskId), "definition.json"));
  }

  private loadTaskState(taskId: string): TaskState | null {
    return readJson<TaskState>(join(this.taskDir(taskId), "state.json"));
  }

  private loadProgressTail(taskId: string): string {
    const path = join(this.taskDir(taskId), "progress.md");
    if (!existsSync(path)) return "";
    const content = readFileSync(path, "utf8");
    if (content.length <= this.progressTailMaxChars) return content;
    return `...[truncated head]\n${content.slice(-this.progressTailMaxChars)}`;
  }

  private listTaskIds(): string[] {
    const dir = join(this.root, "tasks");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  private handoffPath(handoffId: string): string {
    return join(this.root, "handoffs", `${handoffId}.json`);
  }

  private loadHandoff(handoffId: string): Handoff | null {
    return readJson<Handoff>(this.handoffPath(handoffId));
  }

  private listHandoffs(): Handoff[] {
    const dir = join(this.root, "handoffs");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<Handoff>(join(dir, entry.name)))
      .filter((handoff): handoff is Handoff => handoff !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  private bumpVersion(map: Map<string, number>, key: string): number {
    const next = (map.get(key) ?? 0) + 1;
    map.set(key, next);
    return next;
  }

  private hydrateVersionsFromDisk(): void {
    const plan = readJson<Plan>(this.planPath());
    if (plan?.version !== undefined) {
      this.planVersions.set("plan", plan.version);
    }
    for (const id of this.listTaskIdsUnchecked()) {
      const state = readJson<TaskState>(join(this.taskDir(id), "state.json"));
      if (state?.version !== undefined) {
        this.taskVersions.set(id, state.version);
      }
    }
    const handoffDir = join(this.root, "handoffs");
    if (existsSync(handoffDir)) {
      for (const entry of readdirSync(handoffDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const handoff = readJson<Handoff>(join(handoffDir, entry.name));
        if (handoff?.version !== undefined) {
          this.handoffVersions.set(handoff.id, handoff.version);
        }
      }
    }
  }

  private listTaskIdsUnchecked(): string[] {
    const dir = join(this.root, "tasks");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  private planVersion(): number {
    return this.planVersions.get("plan") ?? 0;
  }

  private taskVersion(taskId: string): number {
    return this.taskVersions.get(taskId) ?? 0;
  }

  private createPlan(params: {
    query: string;
    strategy?: string;
    max_agents?: number;
  }): Plan & { version: number } {
    const existing = this.loadPlan();
    if (existing && existing.status === "active") {
      throw new Error(`An active plan already exists for session ${existing.session_id}.`);
    }

    const plan: Plan = {
      session_id: this.sessionId,
      query: params.query,
      strategy: params.strategy ?? "sequential",
      max_agents: params.max_agents ?? 5,
      created_at: new Date().toISOString(),
      status: "active",
    };
    const version = this.bumpVersion(this.planVersions, "plan");
    writeJson(this.planPath(), { ...plan, version });
    debug("orchestration", "create_plan", { session: this.sessionId, version });
    this.server.refresh();
    return { ...plan, version };
  }

  private completePlan(params: { status: "completed" | "cancelled"; expected_version?: number }): {
    status: Plan["status"];
    version: number;
  } {
    const plan = this.loadPlan();
    if (!plan) throw new Error("No plan exists.");
    const current = this.planVersion();
    if (params.expected_version !== undefined && params.expected_version !== current) {
      debug("orchestration", "complete_plan_conflict", {
        expected: params.expected_version,
        current,
      });
      return { status: plan.status, version: current };
    }
    const version = this.bumpVersion(this.planVersions, "plan");
    const next: Plan = { ...plan, status: params.status, version };
    writeJson(this.planPath(), next);
    debug("orchestration", "complete_plan", { status: params.status, version });
    this.server.refresh();
    return { status: next.status, version };
  }

  private createTask(params: { name: string; goal: string; depends_on?: string[] }): {
    id: string;
    version: number;
  } {
    const id = `task-${crypto.randomUUID().slice(0, 8)}`;
    const definition: TaskDefinition = {
      id,
      name: params.name,
      goal: params.goal,
      depends_on: params.depends_on ?? [],
      created_at: new Date().toISOString(),
    };
    const state: TaskState = {
      status: "pending",
      updated_at: definition.created_at,
      iteration: 0,
    };
    const version = this.bumpVersion(this.taskVersions, id);
    writeJson(join(this.taskDir(id), "definition.json"), definition);
    writeJson(join(this.taskDir(id), "state.json"), { ...state, version });
    debug("orchestration", "create_task", {
      id,
      name: params.name,
      depends_on: definition.depends_on,
      version,
    });
    this.server.refresh();
    return { id, version };
  }

  private updateTaskState(
    taskId: string,
    update: Partial<TaskState>,
    expectedVersion: number | undefined,
  ): { version: number; state: TaskState } | { error: "version_conflict"; currentVersion: number } {
    const state = this.loadTaskState(taskId);
    if (!state) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    const current = this.taskVersion(taskId);
    if (expectedVersion !== undefined && expectedVersion !== current) {
      debug("orchestration", "task_version_conflict", {
        taskId,
        expected: expectedVersion,
        current,
      });
      return { error: "version_conflict", currentVersion: current };
    }

    const version = this.bumpVersion(this.taskVersions, taskId);
    const next: TaskState = {
      ...state,
      ...update,
      updated_at: new Date().toISOString(),
      iteration: state.iteration + 1,
      version,
    };
    writeJson(join(this.taskDir(taskId), "state.json"), next);
    debug("orchestration", "update_task", {
      taskId,
      prev_status: state.status,
      next_status: next.status,
      version,
    });
    this.server.refresh();
    return { version, state: next };
  }

  private unmetDependencies(taskId: string): string[] {
    const def = this.loadTaskDefinition(taskId);
    if (!def?.depends_on?.length) return [];
    const unmet: string[] = [];
    for (const depId of def.depends_on) {
      const depState = this.loadTaskState(depId);
      if (!depState || depState.status !== "completed") {
        unmet.push(depId);
      }
    }
    return unmet;
  }

  private startTask(params: {
    task_id: string;
    expected_version?: number;
  }): { version: number; status: TaskStatus } | { error: string; currentVersion: number } {
    const unmet = this.unmetDependencies(params.task_id);
    if (unmet.length > 0) {
      throw new Error(
        `Cannot start task ${params.task_id}: unmet dependencies [${unmet.join(", ")}].`,
      );
    }
    const result = this.updateTaskState(
      params.task_id,
      { status: "running" },
      params.expected_version,
    );
    if ("error" in result) return result;
    return { version: result.version, status: result.state.status };
  }

  private appendProgress(params: { task_id: string; message: string }): {
    version: number;
    bytes: number;
  } {
    if (!this.loadTaskState(params.task_id)) {
      throw new Error(`Unknown task: ${params.task_id}`);
    }
    const timestamp = new Date().toISOString();
    appendText(
      join(this.taskDir(params.task_id), "progress.md"),
      `- [${timestamp}] ${params.message}`,
    );
    // progress.md is append-only; state.json is untouched so CAS versions
    // stay consistent across restarts. Return the current version unchanged.
    const version = this.taskVersion(params.task_id);
    this.server.refresh();
    return { version, bytes: params.message.length };
  }

  private completeTask(params: {
    task_id: string;
    result: string;
    expected_version?: number;
  }): { version: number; status: TaskStatus } | { error: string; currentVersion: number } {
    if (!this.loadTaskState(params.task_id)) {
      throw new Error(`Unknown task: ${params.task_id}`);
    }
    const result = this.updateTaskState(
      params.task_id,
      { status: "completed", completed_at: new Date().toISOString() },
      params.expected_version,
    );
    if ("error" in result) return result;
    if (params.result.length > 0) {
      const resultPath = join(this.taskDir(params.task_id), "result.md");
      mkdirSync(dirname(resultPath), { recursive: true });
      writeFileSync(resultPath, params.result, "utf8");
    }
    return { version: result.version, status: result.state.status };
  }

  private failTask(params: {
    task_id: string;
    error: string;
    expected_version?: number;
  }): { version: number; status: TaskStatus } | { error: string; currentVersion: number } {
    const result = this.updateTaskState(
      params.task_id,
      { status: "failed", error: params.error, completed_at: new Date().toISOString() },
      params.expected_version,
    );
    if ("error" in result) return result;
    return { version: result.version, status: result.state.status };
  }

  private cancelTask(params: {
    task_id: string;
    expected_version?: number;
  }): { version: number; status: TaskStatus } | { error: string; currentVersion: number } {
    const result = this.updateTaskState(
      params.task_id,
      { status: "cancelled", completed_at: new Date().toISOString() },
      params.expected_version,
    );
    if ("error" in result) return result;
    return { version: result.version, status: result.state.status };
  }

  private getResult(taskId: string): { task_id: string; result: string | null } {
    const resultPath = join(this.taskDir(taskId), "result.md");
    if (!existsSync(resultPath)) {
      return { task_id: taskId, result: null };
    }
    return { task_id: taskId, result: readFileSync(resultPath, "utf8") };
  }

  private createHandoff(params: {
    from_task: string;
    to_task: string;
    request: string;
  }): Handoff & { version: number } {
    if (!this.loadTaskDefinition(params.from_task)) {
      throw new Error(`Unknown from_task: ${params.from_task}`);
    }
    if (!this.loadTaskDefinition(params.to_task)) {
      throw new Error(`Unknown to_task: ${params.to_task}`);
    }

    const id = `handoff-${crypto.randomUUID().slice(0, 8)}`;
    const handoff: Handoff = {
      id,
      from_task: params.from_task,
      to_task: params.to_task,
      request: params.request,
      status: "pending",
      created_at: new Date().toISOString(),
    };
    const version = this.bumpVersion(this.handoffVersions, id);
    writeJson(this.handoffPath(id), { ...handoff, version });
    debug("orchestration", "create_handoff", {
      id,
      from: params.from_task,
      to: params.to_task,
      version,
    });
    this.server.refresh();
    return { ...handoff, version };
  }

  private respondHandoff(params: {
    handoff_id: string;
    response: string;
    expected_version?: number;
  }): { version: number; status: HandoffStatus } | { error: string; currentVersion: number } {
    const handoff = this.loadHandoff(params.handoff_id);
    if (!handoff) {
      throw new Error(`Unknown handoff: ${params.handoff_id}`);
    }
    const current = this.handoffVersions.get(params.handoff_id) ?? 0;
    if (params.expected_version !== undefined && params.expected_version !== current) {
      debug("orchestration", "handoff_version_conflict", {
        handoffId: params.handoff_id,
        expected: params.expected_version,
        current,
      });
      return { error: "version_conflict", currentVersion: current };
    }
    if (handoff.status !== "pending") {
      throw new Error(`Handoff ${params.handoff_id} is already ${handoff.status}.`);
    }
    const version = this.bumpVersion(this.handoffVersions, params.handoff_id);
    const updated: Handoff = {
      ...handoff,
      status: "responded",
      responded_at: new Date().toISOString(),
      response: params.response,
      version,
    };
    writeJson(this.handoffPath(params.handoff_id), updated);
    this.server.refresh();
    return { version, status: updated.status };
  }

  private cancelHandoff(params: {
    handoff_id: string;
    expected_version?: number;
  }): { version: number; status: HandoffStatus } | { error: string; currentVersion: number } {
    const handoff = this.loadHandoff(params.handoff_id);
    if (!handoff) {
      throw new Error(`Unknown handoff: ${params.handoff_id}`);
    }
    const current = this.handoffVersions.get(params.handoff_id) ?? 0;
    if (params.expected_version !== undefined && params.expected_version !== current) {
      debug("orchestration", "handoff_version_conflict", {
        handoffId: params.handoff_id,
        expected: params.expected_version,
        current,
      });
      return { error: "version_conflict", currentVersion: current };
    }
    if (handoff.status !== "pending") {
      throw new Error(`Handoff ${params.handoff_id} is already ${handoff.status}.`);
    }
    const version = this.bumpVersion(this.handoffVersions, params.handoff_id);
    const updated: Handoff = {
      ...handoff,
      status: "cancelled",
      responded_at: new Date().toISOString(),
      version,
    };
    writeJson(this.handoffPath(params.handoff_id), updated);
    this.server.refresh();
    return { version, status: updated.status };
  }

  private buildRootDescriptor() {
    const plan = this.loadPlan();
    const taskIds = this.listTaskIds();
    const states = taskIds
      .map((id) => this.loadTaskState(id))
      .filter((state): state is TaskState => state !== null);
    const counts = {
      total: states.length,
      pending: states.filter((s) => s.status === "pending").length,
      running: states.filter((s) => s.status === "running").length,
      completed: states.filter((s) => s.status === "completed").length,
      failed: states.filter((s) => s.status === "failed").length,
      cancelled: states.filter((s) => s.status === "cancelled").length,
    };

    return {
      type: "context",
      props: {
        session_id: this.sessionId,
        plan_status: plan?.status ?? "none",
        plan_query: plan?.query,
        plan_strategy: plan?.strategy,
        plan_max_agents: plan?.max_agents,
        plan_created_at: plan?.created_at,
        plan_version: plan ? this.planVersion() : undefined,
        task_counts: counts,
        handoff_counts: {
          total: this.listHandoffs().length,
          pending: this.listHandoffs().filter((h) => h.status === "pending").length,
        },
      },
      summary: plan
        ? `Plan "${plan.query}" (${counts.completed}/${counts.total} done)`
        : "No active orchestration plan.",
      actions: {
        create_plan: action(
          {
            query: "string",
            strategy: {
              type: "string",
              description: "Decomposition strategy (e.g. sequential, parallel, breadth-first).",
            },
            max_agents: {
              type: "number",
              description: "Maximum concurrent sub-agents this plan permits.",
            },
          },
          async ({ query, strategy, max_agents }) =>
            this.createPlan({
              query: query as string,
              strategy: typeof strategy === "string" ? strategy : undefined,
              max_agents: typeof max_agents === "number" ? max_agents : undefined,
            }),
          {
            label: "Create Plan",
            description: "Create a new orchestration plan. Fails if an active plan already exists.",
            estimate: "instant",
          },
        ),
        complete_plan: action(
          {
            status: {
              type: "string",
              description: "Final plan status: completed or cancelled.",
            },
            expected_version: {
              type: "number",
              description:
                "Optional CAS guard. If provided, call is a no-op when the plan version has moved on.",
            },
          },
          async ({ status, expected_version }) =>
            this.completePlan({
              status: (status as string) === "cancelled" ? "cancelled" : "completed",
              expected_version: typeof expected_version === "number" ? expected_version : undefined,
            }),
          {
            label: "Complete Plan",
            description: "Mark the active plan as completed or cancelled.",
            estimate: "instant",
          },
        ),
        create_task: action(
          {
            name: "string",
            goal: "string",
            depends_on: {
              type: "array",
              description: "Optional list of task ids this task depends on.",
            },
          },
          async ({ name, goal, depends_on }) =>
            this.createTask({
              name: name as string,
              goal: goal as string,
              depends_on: Array.isArray(depends_on)
                ? depends_on.filter((item): item is string => typeof item === "string")
                : undefined,
            }),
          {
            label: "Create Task",
            description: "Define a task under the active plan.",
            estimate: "instant",
          },
        ),
        create_handoff: action(
          {
            from_task: "string",
            to_task: "string",
            request: "string",
          },
          async ({ from_task, to_task, request }) =>
            this.createHandoff({
              from_task: from_task as string,
              to_task: to_task as string,
              request: request as string,
            }),
          {
            label: "Create Handoff",
            description:
              "Request that one task pass data or context to another. The response lives in the handoff record.",
            estimate: "instant",
          },
        ),
      },
      meta: {
        focus: true,
        salience: 1,
      },
    };
  }

  private buildHandoffsDescriptor() {
    const handoffs = this.listHandoffs();
    const items: ItemDescriptor[] = handoffs.map((handoff) => {
      const version = this.handoffVersions.get(handoff.id) ?? 0;
      return {
        id: handoff.id,
        props: {
          id: handoff.id,
          from_task: handoff.from_task,
          to_task: handoff.to_task,
          request: handoff.request,
          status: handoff.status,
          created_at: handoff.created_at,
          responded_at: handoff.responded_at,
          response_preview: handoff.response ? truncateText(handoff.response, 400) : undefined,
          version,
        },
        summary: `${handoff.from_task} → ${handoff.to_task}: ${handoff.request.slice(0, 80)}`,
        actions: {
          ...(handoff.status === "pending"
            ? {
                respond: action(
                  {
                    response: "string",
                    expected_version: { type: "number" },
                  },
                  async ({ response, expected_version }) =>
                    this.respondHandoff({
                      handoff_id: handoff.id,
                      response: response as string,
                      expected_version:
                        typeof expected_version === "number" ? expected_version : undefined,
                    }),
                  {
                    label: "Respond",
                    description: "Fulfil the handoff request with a response.",
                    estimate: "instant",
                  },
                ),
                cancel: action(
                  { expected_version: { type: "number" } },
                  async ({ expected_version }) =>
                    this.cancelHandoff({
                      handoff_id: handoff.id,
                      expected_version:
                        typeof expected_version === "number" ? expected_version : undefined,
                    }),
                  {
                    label: "Cancel Handoff",
                    description: "Cancel this pending handoff request.",
                    dangerous: true,
                    estimate: "instant",
                  },
                ),
              }
            : {}),
        },
        meta: {
          salience: handoff.status === "pending" ? 0.9 : 0.5,
          urgency: handoff.status === "pending" ? "high" : "low",
        },
      };
    });

    const pending = handoffs.filter((h) => h.status === "pending").length;
    return {
      type: "collection",
      props: {
        count: items.length,
        pending,
      },
      summary: `Handoffs between tasks (${pending} pending).`,
      items,
    };
  }

  private buildTaskActions(
    id: string,
    status: TaskStatus | "unknown" | undefined,
  ): ItemDescriptor["actions"] {
    const actions: ItemDescriptor["actions"] = {
      get_result: action(async () => this.getResult(id), {
        label: "Get Result",
        description: "Read the full result.md for this task.",
        idempotent: true,
        estimate: "fast",
      }),
    };
    if (!status) return actions;

    const isPending = status === "pending";
    const isRunning = status === "running";
    const isActive = isPending || isRunning;

    const depsMet = this.unmetDependencies(id).length === 0;

    if (isPending && depsMet) {
      actions.start = action(
        { expected_version: { type: "number" } },
        async ({ expected_version }) =>
          this.startTask({
            task_id: id,
            expected_version: typeof expected_version === "number" ? expected_version : undefined,
          }),
        {
          label: "Start Task",
          description: "Mark the task as running.",
          estimate: "instant",
        },
      );
    }

    if (isActive) {
      actions.append_progress = action(
        { message: "string" },
        async ({ message }) => this.appendProgress({ task_id: id, message: message as string }),
        {
          label: "Append Progress",
          description: "Append a timestamped line to the task progress log.",
          estimate: "instant",
        },
      );
      actions.cancel = action(
        { expected_version: { type: "number" } },
        async ({ expected_version }) =>
          this.cancelTask({
            task_id: id,
            expected_version: typeof expected_version === "number" ? expected_version : undefined,
          }),
        {
          label: "Cancel Task",
          description: "Mark the task as cancelled.",
          dangerous: true,
          estimate: "instant",
        },
      );
    }

    if (isRunning) {
      actions.complete = action(
        {
          result: "string",
          expected_version: { type: "number" },
        },
        async ({ result, expected_version }) =>
          this.completeTask({
            task_id: id,
            result: result as string,
            expected_version: typeof expected_version === "number" ? expected_version : undefined,
          }),
        {
          label: "Complete Task",
          description: "Write the task result and mark it completed.",
          estimate: "instant",
        },
      );
    }

    if (isActive) {
      actions.fail = action(
        {
          error: "string",
          expected_version: { type: "number" },
        },
        async ({ error, expected_version }) =>
          this.failTask({
            task_id: id,
            error: error as string,
            expected_version: typeof expected_version === "number" ? expected_version : undefined,
          }),
        {
          label: "Fail Task",
          description: "Mark the task as failed with an error message.",
          estimate: "instant",
        },
      );
    }

    return actions;
  }

  private buildTasksDescriptor() {
    const ids = this.listTaskIds();
    const items: ItemDescriptor[] = ids.map((id) => {
      const def = this.loadTaskDefinition(id);
      const state = this.loadTaskState(id);
      const version = this.taskVersion(id);
      const progress = this.loadProgressTail(id);

      return {
        id,
        props: {
          id,
          name: def?.name,
          goal: def?.goal,
          depends_on: def?.depends_on,
          created_at: def?.created_at,
          status: state?.status ?? "unknown",
          iteration: state?.iteration,
          message: state?.message,
          error: state?.error,
          completed_at: state?.completed_at,
          version,
          progress_preview: truncateText(progress, 400),
          unmet_dependencies: this.unmetDependencies(id),
        },
        summary: def ? `${def.name}: ${def.goal}` : id,
        actions: this.buildTaskActions(id, state?.status),
        meta: {
          salience:
            state?.status === "running"
              ? 0.9
              : state?.status === "failed" || state?.status === "cancelled"
                ? 0.8
                : state?.status === "pending"
                  ? 0.7
                  : 0.4,
        },
      };
    });

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: `Tasks in plan (${items.length}).`,
      items,
    };
  }
}
