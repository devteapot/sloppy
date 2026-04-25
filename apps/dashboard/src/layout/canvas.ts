import type { AgentNode, DashboardTask } from "../data/types";
import { layoutByPlan, type PlanLane } from "./dag";

export type LanePlacement = PlanLane & {
  offsetX: number;
  offsetY: number;
};

export type AgentChipPosition = {
  agentId: string;
  /** Canvas-space center. */
  x: number;
  y: number;
  taskId: string;
  planId: string;
};

export type CanvasLayout = {
  lanes: LanePlacement[];
  agentChips: Map<string, AgentChipPosition>;
  width: number;
  height: number;
};

const LANE_GAP = 24;
// Mirror values from layout/dag.ts (could be exported, but keeping local avoids coupling).
const TASK_NODE_PAD_TOP = 14;
const TASK_NODE_NAME_H = 20;
const TASK_NODE_NAME_GAP = 6;
const TASK_NODE_GOAL_LINE_H = 16;
const TASK_NODE_GOAL_GAP = 10;
const TASK_NODE_PAD_BOTTOM = 14;

function chipYOffsetWithinNode(node: {
  task: DashboardTask;
  goalLines: string[];
  height: number;
}): number {
  const goalH =
    node.goalLines.length > 0
      ? TASK_NODE_NAME_GAP + node.goalLines.length * TASK_NODE_GOAL_LINE_H
      : 0;
  // The chip sits in the bottom-left next to the status row.
  const statusY = TASK_NODE_PAD_TOP + TASK_NODE_NAME_H + goalH + TASK_NODE_GOAL_GAP + 14 / 2;
  // statusY equation is approximate to: node.height - PAD_BOTTOM (14).
  void statusY;
  return node.height - TASK_NODE_PAD_BOTTOM + 1;
}

export function buildCanvasLayout(
  tasks: DashboardTask[],
  agents: Record<string, AgentNode>,
  primaryPlanId?: string,
): CanvasLayout {
  const lanes = layoutByPlan(tasks, primaryPlanId);
  const placements: LanePlacement[] = [];
  let cursorY = 0;
  let maxLaneWidth = 0;
  for (const lane of lanes) {
    if (lane.nodes.length === 0) continue;
    placements.push({ ...lane, offsetX: 0, offsetY: cursorY });
    cursorY += lane.height + LANE_GAP;
    if (lane.width > maxLaneWidth) maxLaneWidth = lane.width;
  }

  // Compute agent chip positions in canvas coords.
  const agentChips = new Map<string, AgentChipPosition>();
  const agentsByTaskId = new Map<string, AgentNode[]>();
  for (const agent of Object.values(agents)) {
    if (!agent.taskId) continue;
    const arr = agentsByTaskId.get(agent.taskId) ?? [];
    arr.push(agent);
    agentsByTaskId.set(agent.taskId, arr);
  }
  for (const arr of agentsByTaskId.values()) arr.sort((a, b) => a.id.localeCompare(b.id));

  for (const lane of placements) {
    for (const node of lane.nodes) {
      const taskId = node.task.id;
      const arr = agentsByTaskId.get(taskId);
      if (!arr || arr.length === 0) continue;
      arr.forEach((agent, i) => {
        const localX = node.x - node.width / 2 + 18 + i * 12;
        const localY = node.y - node.height / 2 + chipYOffsetWithinNode(node);
        agentChips.set(agent.id, {
          agentId: agent.id,
          x: lane.offsetX + localX,
          y: lane.offsetY + localY,
          taskId,
          planId: lane.planId,
        });
      });
    }
  }

  const totalHeight = Math.max(cursorY - LANE_GAP, 0);
  const totalWidth = maxLaneWidth;
  return {
    lanes: placements,
    agentChips,
    width: totalWidth,
    height: totalHeight,
  };
}
