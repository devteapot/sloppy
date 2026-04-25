import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { produce } from "solid-js/store";
import type { DashboardStore } from "../data/store";
import { buildCanvasLayout, type CanvasLayout, type LanePlacement } from "../layout/canvas";
import type { DagEdge, DagNode } from "../layout/dag";
import { agentsByTask } from "../model/derive";
import { TaskNode } from "./TaskNode";

const OP_FADE_MS = 1500;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;

export function Canvas(props: { store: DashboardStore }) {
  const { store } = props;
  let svgRef: SVGSVGElement | undefined;
  const [viewportW, setViewportW] = createSignal(1200);
  const [viewportH, setViewportH] = createSignal(700);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  const [zoom, setZoom] = createSignal(1);
  const [now, setNow] = createSignal(Date.now());

  const tasksArray = createMemo(() => Object.values(store.tasks));
  const agentsObj = () => store.agents;
  const primaryPlanId = createMemo(() => store.plan.id);

  const layout = createMemo<CanvasLayout>(() =>
    buildCanvasLayout(tasksArray(), agentsObj(), primaryPlanId()),
  );

  // Tick `now` while we have any active ops at all (rendering depends on it for fade).
  createEffect(() => {
    const ops = Object.values(store.activeOps);
    if (ops.length === 0) return;
    const interval = setInterval(() => setNow(Date.now()), 100);
    onCleanup(() => clearInterval(interval));
  });

  // Auto-fit on the first layout that actually contains tasks.
  let didInitialFit = false;
  createEffect(() => {
    if (didInitialFit) return;
    const l = layout();
    if (l.lanes.length === 0) return;
    fit(l.width, l.height, viewportW(), viewportH(), setPan, setZoom);
    didInitialFit = true;
  });

  // Cleanup expired active ops. Re-runs whenever activeOps changes or `now` ticks.
  createEffect(() => {
    const _ops = store.activeOps;
    const _now = now();
    void _ops;
    void _now;
    const expired: string[] = [];
    for (const [key, op] of Object.entries(store.activeOps)) {
      if (op.completedAt && Date.now() - op.completedAt > OP_FADE_MS) {
        expired.push(key);
      }
    }
    if (expired.length > 0) {
      store.setActiveOps(
        produce((o) => {
          for (const k of expired) delete o[k];
        }),
      );
    }
  });

  onMount(() => {
    if (!svgRef) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setViewportW(entry.contentRect.width);
      setViewportH(entry.contentRect.height);
    });
    observer.observe(svgRef);
    onCleanup(() => observer.disconnect());
  });

  const viewBox = createMemo(() => {
    const w = viewportW() / zoom();
    const h = viewportH() / zoom();
    const p = pan();
    return `${-p.x} ${-p.y} ${w} ${h}`;
  });

  // Pan handlers — drag on background.
  let dragStart: { x: number; y: number; pan: { x: number; y: number } } | undefined;
  const onMouseDown = (e: MouseEvent) => {
    if (!(e.target as Element).classList.contains("canvas-bg")) return;
    dragStart = { x: e.clientX, y: e.clientY, pan: { ...pan() } };
    if (svgRef) svgRef.classList.add("dragging");
  };
  const onMouseMove = (e: MouseEvent) => {
    if (!dragStart) return;
    const dx = (e.clientX - dragStart.x) / zoom();
    const dy = (e.clientY - dragStart.y) / zoom();
    setPan({ x: dragStart.pan.x + dx, y: dragStart.pan.y + dy });
  };
  const onMouseUp = () => {
    dragStart = undefined;
    if (svgRef) svgRef.classList.remove("dragging");
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!svgRef) return;
    const rect = svgRef.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const oldZoom = zoom();
    const factor = Math.exp(-e.deltaY * 0.0015);
    const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, oldZoom * factor));
    if (newZoom === oldZoom) return;
    // Zoom around the cursor: keep the canvas point under cursor stable.
    const p = pan();
    const worldX = sx / oldZoom - p.x;
    const worldY = sy / oldZoom - p.y;
    setZoom(newZoom);
    setPan({ x: sx / newZoom - worldX, y: sy / newZoom - worldY });
  };

  return (
    <div class="canvas-wrap">
      <div class="canvas-controls">
        <button
          type="button"
          onClick={() => fit(layout().width, layout().height, viewportW(), viewportH(), setPan, setZoom)}
          title="Fit"
        >
          ⤢
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1);
            setPan({ x: 16, y: 16 });
          }}
          title="Reset"
        >
          ⌖
        </button>
        <span class="canvas-zoom mono dim">{Math.round(zoom() * 100)}%</span>
      </div>
      <svg
        ref={svgRef}
        class="canvas-svg"
        viewBox={viewBox()}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onWheel={onWheel}
      >
        <defs>
          <marker
            id="canvas-arrow"
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={7}
            markerHeight={7}
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" class="arrow" />
          </marker>
          <marker
            id="canvas-arrow-critical"
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={7}
            markerHeight={7}
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" class="arrow critical" />
          </marker>
          <marker
            id="canvas-arrow-supersede"
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={7}
            markerHeight={7}
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" class="arrow supersede" />
          </marker>
        </defs>

        {/* Background rect catches pan drags. Sized larger than viewport. */}
        <rect
          class="canvas-bg"
          x={-10000}
          y={-10000}
          width={20000}
          height={20000}
          fill="transparent"
        />

        <For each={layout().lanes}>{(lane) => <LaneGroup store={store} lane={lane} />}</For>
      </svg>
    </div>
  );
}

function fit(
  layoutW: number,
  layoutH: number,
  viewW: number,
  viewH: number,
  setPan: (p: { x: number; y: number }) => void,
  setZoom: (z: number) => void,
) {
  if (layoutW === 0 || layoutH === 0) return;
  const margin = 24;
  const scaleX = (viewW - margin * 2) / layoutW;
  const scaleY = (viewH - margin * 2) / layoutH;
  const z = Math.min(scaleX, scaleY, 1);
  const clampedZ = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  setZoom(clampedZ);
  // Center.
  const px = (viewW / clampedZ - layoutW) / 2;
  const py = (viewH / clampedZ - layoutH) / 2;
  setPan({ x: Math.max(margin, px), y: Math.max(margin, py) });
}

// ─── Lane group ──────────────────────────────────────────────────────────

function LaneGroup(props: { store: DashboardStore; lane: LanePlacement }) {
  const { store, lane } = props;
  const agentsByTaskMap = createMemo(() => agentsByTask(store.agents));
  const laneTitle = () => {
    if (lane.primary && store.plan.query) return store.plan.query;
    if (lane.orphan) return "Unassigned tasks";
    return lane.planId || "Plan";
  };
  const laneSubtitle = () => {
    if (lane.primary) return store.plan.status;
    if (lane.orphan) return `${lane.nodes.length} tasks`;
    return lane.planId;
  };
  const laneClass = `plan-lane-g${lane.primary ? " primary" : ""}${lane.orphan ? " orphan" : ""}`;

  return (
    <g class={laneClass} transform={`translate(${lane.offsetX}, ${lane.offsetY})`}>
      <rect
        class="lane-bg"
        x={-8}
        y={-30}
        width={Math.max(lane.width + 16, 400)}
        height={lane.height + 38}
        rx={10}
        ry={10}
      />
      <text class="lane-kicker-text" x={4} y={-16}>
        {lane.primary ? "PLAN" : lane.orphan ? "ORPHANS" : "PLAN"}
      </text>
      <text class="lane-title-text" x={48} y={-14}>
        {laneTitle()}
      </text>
      <text class="lane-pill-text" x={Math.max(lane.width + 8, 400)} y={-14} text-anchor="end">
        {laneSubtitle()}
      </text>

      <For each={lane.edges.filter((e) => !e.critical && !e.supersede)}>
        {(edge) => (
          <path
            class={`dag-edge${edge.blocking ? " blocking" : ""}`}
            d={edgePath(edge)}
            marker-end="url(#canvas-arrow)"
          />
        )}
      </For>
      <For each={lane.edges.filter((e) => e.critical && !e.supersede)}>
        {(edge) => (
          <path class="dag-edge critical" d={edgePath(edge)} marker-end="url(#canvas-arrow-critical)" />
        )}
      </For>
      <For each={lane.edges.filter((e) => e.supersede)}>
        {(edge) => (
          <SupersedeEdge edge={edge} fromNode={lane.nodes.find((n) => n.id === edge.from)} />
        )}
      </For>

      <Show when={lane.primary}>
        <For each={store.handoffPulses}>
          {(pulse) => {
            const from = lane.nodes.find((n) => n.id === pulse.fromTask);
            const to = lane.nodes.find((n) => n.id === pulse.toTask);
            return from && to ? (
              <path
                class={`handoff-arc status-${pulse.status}`}
                d={`M ${from.x} ${from.y} Q ${(from.x + to.x) / 2} ${
                  Math.min(from.y, to.y) - 40
                } ${to.x} ${to.y}`}
              />
            ) : null;
          }}
        </For>
      </Show>

      <For each={lane.nodes}>
        {(node: DagNode) => (
          <TaskNode
            node={node}
            agents={(agentsByTaskMap().get(node.id) ?? []) as never}
            pulse={props.store.scheduler.lastPulse[node.id]?.kind}
            selected={props.store.selectedTaskId() === node.id}
            onClick={() => {
              props.store.setSelectedTaskId(node.id);
              props.store.setSelectedAgentId(null);
            }}
          />
        )}
      </For>
    </g>
  );
}

function SupersedeEdge(props: { edge: DagEdge; fromNode?: DagNode }) {
  const { edge } = props;
  const mid = midpoint(edge.points);
  return (
    <g class="supersede-edge-g">
      <path
        class="dag-edge supersede"
        d={edgePath(edge)}
        marker-end="url(#canvas-arrow-supersede)"
      />
      <Show when={mid}>
        {(m) => (
          <g class="supersede-label" transform={`translate(${m().x}, ${m().y})`}>
            <rect class="supersede-label-bg" x={-22} y={-9} width={44} height={16} rx={8} ry={8} />
            <text class="supersede-label-text" x={0} y={2} text-anchor="middle">
              retry
            </text>
          </g>
        )}
      </Show>
    </g>
  );
}

function midpoint(points: Array<{ x: number; y: number }>): { x: number; y: number } | null {
  if (points.length < 2) return null;
  const total = points.length;
  const a = points[Math.floor((total - 1) / 2)]!;
  const b = points[Math.ceil((total - 1) / 2)]!;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function edgePath(edge: DagEdge): string {
  const pts = edge.points;
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0]!.x} ${pts[0]!.y}`;
  if (pts.length === 2) return `M ${pts[0]!.x} ${pts[0]!.y} L ${pts[1]!.x} ${pts[1]!.y}`;
  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}
