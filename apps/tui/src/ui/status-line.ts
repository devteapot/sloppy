import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { SessionViewSnapshot } from "../backend/slop-types";
import { projectIndicators } from "../state/manifest-projection";
import { formatHomePath } from "./display-path";
import { dim } from "./theme";

export type InteractionMode = "default" | "auto-approve" | "plan";

export class StatusLine implements Component {
  private leftText = "";
  private rightText = "";
  private cachedLeftText?: string;
  private cachedRightText?: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  update(snapshot: SessionViewSnapshot, _mode: InteractionMode): void {
    const workspace = snapshot.session.workspaceRoot
      ? formatHomePath(snapshot.session.workspaceRoot)
      : "workspace";
    const model = [snapshot.session.modelProvider, snapshot.session.model]
      .filter(Boolean)
      .join("/");
    const indicators = projectIndicators(snapshot)
      .map((indicator) => indicator.text)
      .filter(Boolean);

    this.leftText = [
      dim(workspace),
      dim(model || "model unset"),
      dim(turnStatusLabel(snapshot)),
      ...indicators,
    ]
      .filter(Boolean)
      .join(" | ");
    this.rightText = contextLabel(snapshot);
    this.invalidate();
  }

  invalidate(): void {
    this.cachedLeftText = undefined;
    this.cachedRightText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (
      this.cachedLines &&
      this.cachedLeftText === this.leftText &&
      this.cachedRightText === this.rightText &&
      this.cachedWidth === width
    ) {
      return this.cachedLines;
    }

    const innerWidth = Math.max(1, width - 2);
    const right = this.rightText ? dim(this.rightText) : "";
    const rightWidth = visibleWidth(right);
    const gapWidth = right ? 2 : 0;
    const maxLeftWidth = Math.max(1, innerWidth - rightWidth - gapWidth);
    const left = truncateToWidth(this.leftText, maxLeftWidth, "…");
    const leftWidth = visibleWidth(left);
    const spacerWidth = Math.max(1, innerWidth - leftWidth - rightWidth);
    const line = ` ${left}${" ".repeat(spacerWidth)}${right}`;

    this.cachedLeftText = this.leftText;
    this.cachedRightText = this.rightText;
    this.cachedWidth = width;
    this.cachedLines = [line];
    return this.cachedLines;
  }
}

export function turnStatusLabel(snapshot: SessionViewSnapshot): string {
  const state = snapshot.turn.state;
  if (state === "idle") {
    return "Idle";
  }
  if (state === "waiting_approval") {
    return "Awaiting approval";
  }
  if (state === "error") {
    return "Error";
  }
  if (state === "running") {
    if (snapshot.turn.phase === "model") {
      return "Thinking";
    }
    if (snapshot.turn.phase === "tool_use") {
      return "Using tools";
    }
    if (snapshot.turn.phase === "awaiting_result") {
      return "Waiting for tools";
    }
    if (snapshot.turn.phase === "complete") {
      return "Wrapping up";
    }
    return "Running";
  }
  return "Connecting";
}

function contextLabel(snapshot: SessionViewSnapshot): string {
  const used = snapshot.usage.lastModelCallInputTokens ?? snapshot.usage.currentTurnInputTokens;
  const window =
    snapshot.usage.modelContextWindowTokens ?? snapshot.llm.selectedContextWindowTokens;
  const state = snapshot.usage.lastStateContextTokens;

  if (used !== undefined && window !== undefined) {
    const parts = [`ctx ${formatTokenCount(used)}/${formatTokenCount(window)}`];
    if (state !== undefined) {
      parts.push(`state ${formatTokenCount(state)}`);
    }
    return parts.join(" | ");
  }

  if (window !== undefined) {
    return `ctx window ${formatTokenCount(window)}`;
  }
  if (state !== undefined) {
    return `state ctx ${formatTokenCount(state)}`;
  }
  return "";
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${formatCompact(value / 1_000_000)}m`;
  }
  if (value >= 1_000) {
    return `${formatCompact(value / 1_000)}k`;
  }
  return String(Math.round(value));
}

function formatCompact(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}
