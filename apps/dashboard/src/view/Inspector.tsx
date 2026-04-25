import { createMemo, For, Show } from "solid-js";
import type { DashboardStore } from "../data/store";
import { downstreamByTask } from "../model/derive";

export function Inspector(props: { store: DashboardStore }) {
  const { store } = props;
  const selectedAgent = createMemo(() => {
    const id = store.selectedAgentId();
    return id ? store.agents[id] : undefined;
  });
  const selectedTask = createMemo(() => {
    const id = store.selectedTaskId();
    return id ? store.tasks[id] : undefined;
  });
  const downstream = createMemo(() =>
    downstreamByTask(Object.values(store.tasks)),
  );
  const visible = createMemo(() => Boolean(selectedAgent() || selectedTask()));

  return (
    <aside class="inspector" classList={{ open: visible() }}>
      <button
        type="button"
        class="inspector-close"
        onClick={() => {
          store.setSelectedAgentId(null);
          store.setSelectedTaskId(null);
        }}
      >
        ×
      </button>
      <Show when={selectedTask()}>
        {(task) => (
          <section class="inspect-section">
            <h2>
              {task().name || task().id}
              <span class={`pill ${task().status}`}>{task().status}</span>
            </h2>
            <div class="mono dim">{task().id}</div>
            <p class="goal">{task().goal}</p>
            <dl>
              <dt>deps</dt>
              <dd>{task().dependsOn.length ? task().dependsOn.join(", ") : "root"}</dd>
              <Show when={task().unmetDependencies.length > 0}>
                <dt>blocked by</dt>
                <dd class="blocked">{task().unmetDependencies.join(", ")}</dd>
              </Show>
              <Show when={(downstream().get(task().id) ?? []).length > 0}>
                <dt>unblocks</dt>
                <dd>{(downstream().get(task().id) ?? []).join(", ")}</dd>
              </Show>
              <dt>iter · ver</dt>
              <dd>
                {task().iteration} · v{task().version}
              </dd>
            </dl>
            <Show when={task().error}>
              <div class="task-preview error">{task().error}</div>
            </Show>
            <Show when={task().resultPreview}>
              <div class="task-preview result">{task().resultPreview}</div>
            </Show>
            <Show when={!task().resultPreview && task().progressPreview}>
              <div class="task-preview">{task().progressPreview}</div>
            </Show>
          </section>
        )}
      </Show>
      <Show when={selectedAgent()}>
        {(agent) => (
          <section class="inspect-section">
            <h2>
              {agent().name}
              <span class="actor-kind">{agent().kind}</span>
            </h2>
            <dl>
              <dt>id</dt>
              <dd class="mono">{agent().id}</dd>
              <Show when={agent().parentId}>
                <dt>parent</dt>
                <dd class="mono">{agent().parentId}</dd>
              </Show>
              <Show when={agent().taskId}>
                <dt>task</dt>
                <dd class="mono">{agent().taskId}</dd>
              </Show>
              <dt>tools</dt>
              <dd>{agent().toolCount}</dd>
              <Show when={agent().errorCount > 0}>
                <dt>errors</dt>
                <dd class="bad">{agent().errorCount}</dd>
              </Show>
              <Show when={agent().currentTool}>
                <dt>running</dt>
                <dd class="mono">{agent().currentTool}</dd>
              </Show>
            </dl>
            <div class="section-title">recent</div>
            <ul class="recent-list">
              <For each={agent().recent}>
                {(r) => (
                  <li>
                    <span class="t">{formatAgo(Date.now() - r.ts)}</span>
                    <span class={`op-${r.kind}`}>{r.label}</span>
                  </li>
                )}
              </For>
              <Show when={agent().recent.length === 0}>
                <li class="dim">no activity</li>
              </Show>
            </ul>
          </section>
        )}
      </Show>
    </aside>
  );
}

function formatAgo(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m`;
}
