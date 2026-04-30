import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { DashboardDigestAction } from "../data/types";
import type { DashboardStore } from "../data/store";

export function ControlSurface(props: { store: DashboardStore }) {
  const [pendingAction, setPendingAction] = createSignal<string | null>(null);
  const [message, setMessage] = createSignal("");
  const digest = () => props.store.digest();

  async function runAction(action: DashboardDigestAction) {
    if (!digest()?.actionEnabled || pendingAction()) return;
    setPendingAction(action.id);
    setMessage("");
    try {
      const response = await fetch("/api/digest-actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action_id: action.id }),
      });
      const result = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) {
        setMessage(result.error ?? "Action failed.");
        return;
      }
      setMessage("Action sent.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <aside class="control-surface">
      <div class="pane-head">
        <div>
          <div class="pane-kicker">Docs/12</div>
          <div class="pane-title">Digest Controls</div>
        </div>
        <Show when={digest()}>
          {(item) => <span class={`pill ${item().status}`}>{item().status}</span>}
        </Show>
      </div>
      <Show
        when={digest()}
        fallback={<div class="pane-empty">No typed digest has been generated yet.</div>}
      >
        {(item) => (
          <div class="digest-body">
            <div class="digest-meta mono dim">
              {item().id} · {formatTime(item().createdAt)}
            </div>
            <ul class="digest-headline">
              <For each={item().headline.slice(0, 5)}>{(line) => <li>{line}</li>}</For>
            </ul>
            <div class="digest-grid">
              <Metric label="Escalations" value={String(item().sections.escalations.length)} />
              <Metric label="Auto" value={String(item().sections.autoResolutionCount)} />
              <Metric label="Near Misses" value={String(item().sections.nearMisses.length)} />
              <Metric
                label="Criteria"
                value={`${item().sections.drift.criteriaSatisfied}/${item().sections.drift.criteriaTotal}`}
              />
              <Metric label="Coverage Gaps" value={String(item().sections.drift.coverageGapCount)} />
              <Metric label="Budget" value={item().sections.budget.exceeded ? "exceeded" : "ok"} />
            </div>
            <Section title="Escalations">
              <For
                each={item().sections.escalations.slice(0, 3)}
                fallback={<div class="digest-empty">none</div>}
              >
                {(gate) => (
                  <div class="digest-row">
                    <span class="mono">{gate.gateType}</span>
                    <span>{gate.summary}</span>
                  </div>
                )}
              </For>
            </Section>
            <Section title="Drift">
              <For
                each={item().sections.drift.recentEvents.slice(0, 3)}
                fallback={<div class="digest-empty">no recent events</div>}
              >
                {(event) => (
                  <div class="digest-row">
                    <span class={`severity ${event.severity}`}>{event.kind}</span>
                    <span>{event.summary}</span>
                  </div>
                )}
              </For>
            </Section>
            <Section title="Next">
              <div class="digest-row">
                <span class="mono">{item().sections.next.pendingGateCount} gates</span>
                <span>{item().sections.next.nextReadySlices.slice(0, 3).join(", ") || "no ready slices"}</span>
              </div>
            </Section>
            <Show when={item().sourceRefs.length > 0}>
              <div class="source-refs">
                <For each={item().sourceRefs.slice(0, 8)}>{(ref) => <span>{ref}</span>}</For>
              </div>
            </Show>
            <div class="digest-actions">
              <For
                each={item().actions}
                fallback={<span class="dim mono">No digest actions.</span>}
              >
                {(action) => (
                  <button
                    type="button"
                    class={`digest-action ${action.urgency}`}
                    disabled={!item().actionEnabled || pendingAction() !== null}
                    title={`${action.actionPath} ${action.actionName}`}
                    onClick={() => void runAction(action)}
                  >
                    {pendingAction() === action.id ? "Running" : action.label}
                  </button>
                )}
              </For>
            </div>
            <Show when={!item().actionEnabled}>
              <div class="digest-note">Start with --session to enable actions.</div>
            </Show>
            <Show when={message()}>
              {(text) => <div class="digest-note">{text()}</div>}
            </Show>
          </div>
        )}
      </Show>
    </aside>
  );
}

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <section class="digest-section">
      <div class="section-title">{props.title}</div>
      {props.children}
    </section>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <div class="digest-metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function formatTime(iso: string): string {
  if (!iso) return "no timestamp";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
