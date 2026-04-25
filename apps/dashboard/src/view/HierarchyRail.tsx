import { For, Show } from "solid-js";
import type { DashboardStore } from "../data/store";
import { childrenOf, hierarchyRoots } from "../model/derive";
import type { AgentNode } from "../data/types";

export function HierarchyRail(props: { store: DashboardStore }) {
  const { store } = props;
  return (
    <aside class="hierarchy-rail">
      <div class="rail-head">
        <div class="rail-kicker">hierarchy</div>
        <h2>Agents</h2>
      </div>
      <ul class="agent-tree">
        <For each={hierarchyRoots(store.agents)}>
          {(agent) => <AgentRow store={store} agent={agent} depth={0} />}
        </For>
      </ul>
    </aside>
  );
}

function AgentRow(props: { store: DashboardStore; agent: AgentNode; depth: number }) {
  const kids = () => childrenOf(props.store.agents, props.agent.id);
  const selected = () => props.store.selectedAgentId() === props.agent.id;
  const task = () => (props.agent.taskId ? props.store.tasks[props.agent.taskId] : undefined);
  return (
    <li class={`agent-row kind-${props.agent.kind}${selected() ? " selected" : ""}`}>
      <button
        type="button"
        class="agent-btn"
        style={{ "padding-left": `${8 + props.depth * 14}px` }}
        onClick={() => {
          props.store.setSelectedAgentId(props.agent.id);
          props.store.setSelectedTaskId(props.agent.taskId ?? null);
        }}
      >
        <span
          class={`agent-dot${props.agent.currentTool ? " busy" : ""}${
            props.agent.pendingApproval ? " approval" : ""
          }${props.agent.errorCount > 0 ? " error" : ""}`}
        />
        <span class="agent-name">{props.agent.name}</span>
        <Show when={props.agent.currentTool}>
          {(tool) => <span class="agent-tool mono">{tool()}</span>}
        </Show>
        <Show when={task()}>
          {(t) => <span class={`agent-task pill ${t().status}`}>{t().status}</span>}
        </Show>
        <Show when={props.agent.toolCount > 0 || props.agent.errorCount > 0}>
          <span class="agent-counters">
            {props.agent.toolCount}
            {props.agent.errorCount > 0 ? ` · !${props.agent.errorCount}` : ""}
          </span>
        </Show>
      </button>
      <Show when={kids().length > 0}>
        <ul>
          <For each={kids()}>
            {(child) => <AgentRow store={props.store} agent={child} depth={props.depth + 1} />}
          </For>
        </ul>
      </Show>
    </li>
  );
}
