export function dependencyCycle(dependencies: Map<string, string[]>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (taskId: string): string[] | null => {
    if (visiting.has(taskId)) {
      const cycleStart = stack.indexOf(taskId);
      return [...stack.slice(cycleStart), taskId];
    }
    if (visited.has(taskId)) {
      return null;
    }

    visiting.add(taskId);
    stack.push(taskId);
    for (const dependencyId of dependencies.get(taskId) ?? []) {
      if (!dependencies.has(dependencyId)) continue;
      const cycle = visit(dependencyId);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(taskId);
    visited.add(taskId);
    return null;
  };

  for (const taskId of dependencies.keys()) {
    const cycle = visit(taskId);
    if (cycle) return cycle;
  }

  return null;
}
