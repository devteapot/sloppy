import { For, Show } from "solid-js";
import type { AgentNode } from "../data/types";
import type { DagNode } from "../layout/dag";

export function TaskNode(props: {
  node: DagNode;
  agents: AgentNode[];
  pulse?: "scheduled" | "unblocked" | "started";
  selected: boolean;
  onClick: () => void;
}) {
  const { node } = props;
  const task = node.task;
  const x = node.x - node.width / 2;
  const y = node.y - node.height / 2;
  const nameY = 14 + 6;
  const goalStartY = nameY + 8 + 8;
  const statusY = node.height - 14;

  return (
    <g
      class={`task-node status-${task.status}${props.selected ? " selected" : ""}${
        props.pulse ? ` pulse-${props.pulse}` : ""
      }`}
      transform={`translate(${x}, ${y})`}
      onClick={props.onClick}
    >
      <rect class="task-body" x={0} y={0} width={node.width} height={node.height} rx={10} ry={10} />
      <Show when={task.status === "verifying"}>
        <rect
          class="task-verify-ring"
          x={-4}
          y={-4}
          width={node.width + 8}
          height={node.height + 8}
          rx={12}
          ry={12}
        />
      </Show>
      <text class="task-name" x={14} y={nameY}>
        {node.nameLine}
      </text>
      <For each={node.goalLines}>
        {(line, i) => (
          <text class="task-goal" x={14} y={goalStartY + i() * 16}>
            {line}
          </text>
        )}
      </For>
      <text class="task-status" x={node.width - 14} y={statusY} text-anchor="end">
        {task.status}
      </text>
      <Show when={task.unmetDependencies.length > 0 && task.status !== "completed"}>
        <text class="task-icon" x={node.width - 14} y={nameY} text-anchor="end">
          ▣
        </text>
      </Show>
      <Show when={task.status === "completed"}>
        <text class="task-icon ok" x={node.width - 14} y={nameY} text-anchor="end">
          ✓
        </text>
      </Show>
      <Show when={task.status === "failed"}>
        <text class="task-icon fail" x={node.width - 14} y={nameY} text-anchor="end">
          ✕
        </text>
      </Show>
      <For each={props.agents}>
        {(agent, i) => (
          <circle
            class={`agent-chip${agent.currentTool ? " busy" : ""}${
              agent.pendingApproval ? " approval" : ""
            }`}
            cx={18 + i() * 12}
            cy={statusY + 3}
            r={5}
          >
            <title>{agent.name}</title>
          </circle>
        )}
      </For>
    </g>
  );
}
