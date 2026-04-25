import dagre from "@dagrejs/dagre";
import type { DashboardTask } from "../data/types";

export type DagNode = {
  id: string;
  planId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  task: DashboardTask;
  nameLine: string;
  goalLines: string[];
};

export type DagEdge = {
  from: string;
  to: string;
  planId: string;
  points: Array<{ x: number; y: number }>;
  blocking: boolean;
  critical: boolean;
  supersede: boolean;
};

export type PlanLane = {
  planId: string;
  primary: boolean;
  orphan: boolean;
  nodes: DagNode[];
  edges: DagEdge[];
  width: number;
  height: number;
};

const NODE_W = 260;
const PAD_TOP = 14;
const PAD_BOTTOM = 14;
const NAME_H = 20;
const NAME_GAP = 6;
const GOAL_LINE_H = 16;
const GOAL_GAP = 10;
const STATUS_H = 14;
const GOAL_CHAR_BUDGET = 34;
const NAME_CHAR_BUDGET = 28;
const MAX_GOAL_LINES = 3;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function wrap(text: string, width: number, maxLines: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const words = trimmed.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (lines.length >= maxLines) break;
    current = word;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines) {
    // If text still had more content, mark last line with ellipsis.
    const joined = lines.join(" ");
    if (joined.length < trimmed.length) {
      const last = lines[lines.length - 1]!;
      lines[lines.length - 1] = truncate(last, width);
      if (!lines[lines.length - 1]?.endsWith("…")) {
        lines[lines.length - 1] = `${lines[lines.length - 1]?.replace(/[\s.]*$/, "")}…`;
      }
    }
  }
  return lines;
}

function measureNode(task: DashboardTask): {
  width: number;
  height: number;
  nameLine: string;
  goalLines: string[];
} {
  const nameLine = truncate(task.name || task.id, NAME_CHAR_BUDGET);
  const goalLines = wrap(task.goal, GOAL_CHAR_BUDGET, MAX_GOAL_LINES);
  const height =
    PAD_TOP +
    NAME_H +
    (goalLines.length > 0 ? NAME_GAP + goalLines.length * GOAL_LINE_H : 0) +
    GOAL_GAP +
    STATUS_H +
    PAD_BOTTOM;
  return { width: NODE_W, height, nameLine, goalLines };
}

function groupByPlan(
  tasks: DashboardTask[],
  primaryPlanId?: string,
): Array<{
  planId: string;
  primary: boolean;
  orphan: boolean;
  tasks: DashboardTask[];
}> {
  const groups = new Map<string, DashboardTask[]>();
  for (const task of tasks) {
    const key = task.planId ?? "";
    const arr = groups.get(key) ?? [];
    arr.push(task);
    groups.set(key, arr);
  }
  const out: Array<{ planId: string; primary: boolean; orphan: boolean; tasks: DashboardTask[] }> =
    [];
  // The primary lane represents whatever plan the server is currently pointed at.
  // When the server provides an explicit id, group by that id; otherwise the
  // primary plan's tasks are those without any planId (the "default" bucket).
  const primaryKey = primaryPlanId ?? "";
  if (groups.has(primaryKey)) {
    out.push({
      planId: primaryKey,
      primary: true,
      orphan: false,
      tasks: groups.get(primaryKey)!,
    });
    groups.delete(primaryKey);
  }
  // Remaining groups are legacy/orphan plans. When the primary had an id, tasks
  // without any planId also become orphans. Sort: known ids first, unassigned last.
  const rest = [...groups.entries()].sort(([a], [b]) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });
  for (const [planId, list] of rest) {
    out.push({ planId, primary: false, orphan: planId === "", tasks: list });
  }
  return out;
}

function computeCriticalEdges(tasks: DashboardTask[]): Set<string> {
  // An edge A→B is "critical" iff it is currently gating progress:
  //   - B is still waiting (not completed / cancelled / superseded)
  //   - A is not yet completed (still contributing to blocking B)
  // Additionally we include edges that transitively lead into a blocked task,
  // but the traversal stops the moment we reach a completed ancestor.
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const result = new Set<string>();
  const seeds = tasks.filter(
    (t) => t.status === "failed" || (t.unmetDependencies.length > 0 && t.status !== "completed"),
  );
  const visited = new Set<string>();
  const stack = seeds.map((s) => s.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const task = byId.get(id);
    if (!task) continue;
    for (const dep of task.dependsOn) {
      const depTask = byId.get(dep);
      if (!depTask) continue;
      // Skip edges from already-satisfied ancestors.
      if (depTask.status === "completed" || depTask.status === "superseded") continue;
      result.add(`${dep}→${id}`);
      stack.push(dep);
    }
  }
  return result;
}

function layoutLane(
  planId: string,
  primary: boolean,
  orphan: boolean,
  tasks: DashboardTask[],
): PlanLane {
  if (tasks.length === 0) {
    return { planId, primary, orphan, nodes: [], edges: [], width: 0, height: 0 };
  }
  const g = new dagre.graphlib.Graph({ directed: true });
  g.setGraph({ rankdir: "TB", nodesep: 36, ranksep: 50, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const measured = new Map<string, ReturnType<typeof measureNode>>();
  for (const task of tasks) {
    const m = measureNode(task);
    measured.set(task.id, m);
    g.setNode(task.id, { width: m.width, height: m.height });
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (byId.has(dep)) g.setEdge(dep, task.id, { kind: "depends" });
    }
  }
  // Supersede edges: superseded task -> its replacement. Telling dagre about
  // them keeps the pair adjacent in layout; they render with their own style.
  for (const task of tasks) {
    if (!task.supersededBy) continue;
    if (!byId.has(task.supersededBy)) continue;
    g.setEdge(task.id, task.supersededBy, { kind: "supersede" });
  }

  dagre.layout(g);

  const nodes: DagNode[] = tasks.map((task) => {
    const n = g.node(task.id);
    const m = measured.get(task.id)!;
    return {
      id: task.id,
      planId,
      x: n.x,
      y: n.y,
      width: n.width,
      height: n.height,
      task,
      nameLine: m.nameLine,
      goalLines: m.goalLines,
    };
  });

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const critical = computeCriticalEdges(tasks);

  const edges: DagEdge[] = g.edges().map((e) => {
    const edge = g.edge(e) as { points?: Array<{ x: number; y: number }>; kind?: string };
    const isSupersede = edge.kind === "supersede";
    const child = byId.get(e.w);
    const blocking = !isSupersede && Boolean(child?.unmetDependencies.includes(e.v));
    const isCritical = !isSupersede && critical.has(`${e.v}→${e.w}`);
    const raw = (edge.points ?? []).map((p: { x: number; y: number }) => ({ x: p.x, y: p.y }));
    const clipped = clipEndpoints(raw, nodeById.get(e.v), nodeById.get(e.w));
    return {
      from: e.v,
      to: e.w,
      planId,
      points: clipped,
      blocking,
      critical: isCritical,
      supersede: isSupersede,
    };
  });

  const graph = g.graph();
  return {
    planId,
    primary,
    orphan,
    nodes,
    edges,
    width: graph.width ?? 0,
    height: graph.height ?? 0,
  };
}

/** Clip the first and last segments of an edge polyline to the node rectangles. */
function clipEndpoints(
  points: Array<{ x: number; y: number }>,
  from?: DagNode,
  to?: DagNode,
): Array<{ x: number; y: number }> {
  if (points.length < 2) return points;
  const first = from ? clipSegmentToRect(points[1]!, points[0]!, from) : points[0]!;
  const last = to
    ? clipSegmentToRect(points[points.length - 2]!, points[points.length - 1]!, to)
    : points[points.length - 1]!;
  return [first, ...points.slice(1, -1), last];
}

/** Given a segment from `out` (outside rect) to `in` (inside/near rect center),
 *  return the point where the segment crosses the rect boundary. */
function clipSegmentToRect(
  outside: { x: number; y: number },
  inside: { x: number; y: number },
  node: DagNode,
): { x: number; y: number } {
  const halfW = node.width / 2;
  const halfH = node.height / 2;
  const left = node.x - halfW;
  const right = node.x + halfW;
  const top = node.y - halfH;
  const bottom = node.y + halfH;

  const dx = inside.x - outside.x;
  const dy = inside.y - outside.y;
  if (dx === 0 && dy === 0) return inside;

  // Parametric segment from outside (t=0) to inside (t=1). Find entry point into rect.
  const candidates: number[] = [];
  if (dx !== 0) {
    const tLeft = (left - outside.x) / dx;
    const tRight = (right - outside.x) / dx;
    candidates.push(tLeft, tRight);
  }
  if (dy !== 0) {
    const tTop = (top - outside.y) / dy;
    const tBottom = (bottom - outside.y) / dy;
    candidates.push(tTop, tBottom);
  }
  // Pick the largest t in [0,1] that lands on the rect border.
  let best = 1;
  for (const t of candidates) {
    if (t < 0 || t > 1) continue;
    const px = outside.x + dx * t;
    const py = outside.y + dy * t;
    const eps = 0.5;
    const onBorder = px >= left - eps && px <= right + eps && py >= top - eps && py <= bottom + eps;
    if (onBorder && t < best) best = t;
  }
  return {
    x: outside.x + dx * best,
    y: outside.y + dy * best,
  };
}

export function layoutByPlan(tasks: DashboardTask[], primaryPlanId?: string): PlanLane[] {
  const groups = groupByPlan(tasks, primaryPlanId);
  return groups.map((g) => layoutLane(g.planId, g.primary, g.orphan, g.tasks));
}
