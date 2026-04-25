import type { AgentNode, DashboardTask } from "../data/types";

export function downstreamByTask(tasks: DashboardTask[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      const existing = out.get(dep) ?? [];
      existing.push(task.id);
      out.set(dep, existing);
    }
  }
  for (const ids of out.values()) ids.sort();
  return out;
}

export function agentsByTask(agents: Record<string, AgentNode>): Map<string, AgentNode[]> {
  const out = new Map<string, AgentNode[]>();
  for (const agent of Object.values(agents)) {
    if (!agent.taskId) continue;
    const arr = out.get(agent.taskId) ?? [];
    arr.push(agent);
    out.set(agent.taskId, arr);
  }
  return out;
}

export function hierarchyRoots(agents: Record<string, AgentNode>): AgentNode[] {
  return Object.values(agents)
    .filter((a) => !a.parentId || !agents[a.parentId])
    .sort((a, b) =>
      a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "orchestrator" ? -1 : 1,
    );
}

export function childrenOf(agents: Record<string, AgentNode>, parentId: string): AgentNode[] {
  return Object.values(agents)
    .filter((a) => a.parentId === parentId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function taskCounts(tasks: DashboardTask[]) {
  return tasks.reduce(
    (acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
}

export function topFiles<T extends { lastOpMs: number }>(
  files: Record<string, T>,
  limit = 14,
): T[] {
  return Object.values(files)
    .sort((a, b) => b.lastOpMs - a.lastOpMs)
    .slice(0, limit);
}
