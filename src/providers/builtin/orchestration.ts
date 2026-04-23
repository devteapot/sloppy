import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

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
};

type Plan = {
  session_id: string;
  query: string;
  strategy: string;
  max_agents: number;
  created_at: string;
  status: "active" | "completed" | "cancelled";
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

  constructor(options: OrchestrationProviderOptions) {
    this.root = resolve(options.workspaceRoot, ORCHESTRATION_DIR);
    this.sessionId = options.sessionId ?? "default";
    this.progressTailMaxChars = options.progressTailMaxChars ?? 2048;

    mkdirSync(this.root, { recursive: true });
    mkdirSync(join(this.root, "tasks"), { recursive: true });

    this.server = createSlopServer({
      id: "orchestration",
      name: "Orchestration",
    });

    this.server.register("orchestration", () => this.buildRootDescriptor());
    this.server.register("tasks", () => this.buildTasksDescriptor());
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

  private bumpVersion(map: Map<string, number>, key: string): number {
    const next = (map.get(key) ?? 0) + 1;
    map.set(key, next);
    return next;
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
    writeJson(this.planPath(), plan);
    const version = this.bumpVersion(this.planVersions, "plan");
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
      return { status: plan.status, version: current };
    }
    const next: Plan = { ...plan, status: params.status };
    writeJson(this.planPath(), next);
    const version = this.bumpVersion(this.planVersions, "plan");
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
    writeJson(join(this.taskDir(id), "definition.json"), definition);
    writeJson(join(this.taskDir(id), "state.json"), state);
    const version = this.bumpVersion(this.taskVersions, id);
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
      return { error: "version_conflict", currentVersion: current };
    }

    const next: TaskState = {
      ...state,
      ...update,
      updated_at: new Date().toISOString(),
      iteration: state.iteration + 1,
    };
    writeJson(join(this.taskDir(taskId), "state.json"), next);
    const version = this.bumpVersion(this.taskVersions, taskId);
    this.server.refresh();
    return { version, state: next };
  }

  private startTask(params: {
    task_id: string;
    expected_version?: number;
  }): { version: number; status: TaskStatus } | { error: string; currentVersion: number } {
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
    const version = this.bumpVersion(this.taskVersions, params.task_id);
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
    const resultPath = join(this.taskDir(params.task_id), "result.md");
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, params.result, "utf8");
    const result = this.updateTaskState(
      params.task_id,
      { status: "completed", completed_at: new Date().toISOString() },
      params.expected_version,
    );
    if ("error" in result) return result;
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
      },
      meta: {
        focus: true,
        salience: 1,
      },
    };
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
        },
        summary: def ? `${def.name}: ${def.goal}` : id,
        actions: {
          start: action(
            {
              expected_version: { type: "number" },
            },
            async ({ expected_version }) =>
              this.startTask({
                task_id: id,
                expected_version:
                  typeof expected_version === "number" ? expected_version : undefined,
              }),
            {
              label: "Start Task",
              description: "Mark the task as running.",
              estimate: "instant",
            },
          ),
          append_progress: action(
            { message: "string" },
            async ({ message }) => this.appendProgress({ task_id: id, message: message as string }),
            {
              label: "Append Progress",
              description: "Append a timestamped line to the task progress log.",
              estimate: "instant",
            },
          ),
          complete: action(
            {
              result: "string",
              expected_version: { type: "number" },
            },
            async ({ result, expected_version }) =>
              this.completeTask({
                task_id: id,
                result: result as string,
                expected_version:
                  typeof expected_version === "number" ? expected_version : undefined,
              }),
            {
              label: "Complete Task",
              description: "Write the task result and mark it completed.",
              estimate: "instant",
            },
          ),
          fail: action(
            {
              error: "string",
              expected_version: { type: "number" },
            },
            async ({ error, expected_version }) =>
              this.failTask({
                task_id: id,
                error: error as string,
                expected_version:
                  typeof expected_version === "number" ? expected_version : undefined,
              }),
            {
              label: "Fail Task",
              description: "Mark the task as failed with an error message.",
              estimate: "instant",
            },
          ),
          cancel: action(
            { expected_version: { type: "number" } },
            async ({ expected_version }) =>
              this.cancelTask({
                task_id: id,
                expected_version:
                  typeof expected_version === "number" ? expected_version : undefined,
              }),
            {
              label: "Cancel Task",
              description: "Mark the task as cancelled.",
              dangerous: true,
              estimate: "instant",
            },
          ),
          get_result: action(async () => this.getResult(id), {
            label: "Get Result",
            description: "Read the full result.md for this task.",
            idempotent: true,
            estimate: "fast",
          }),
        },
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
