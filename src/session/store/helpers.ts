import type {
  ActivityItem,
  AgentTurnPhase,
  ExternalAppSnapshot,
  TurnStateSnapshot,
} from "../types";
import type { SessionStoreState } from "./state";

export function now(): string {
  return new Date().toISOString();
}

export function buildId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function buildMirroredItemId(prefix: string, providerId: string, sourceId: string): string {
  const cleanProviderId = providerId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const cleanSourceId = sourceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${prefix}-${cleanProviderId}-${cleanSourceId}`;
}

export function deriveTitle(userText: string): string {
  const truncated = userText.slice(0, 60);
  const trimmed = truncated.trim();
  if (!trimmed) {
    return "New Session";
  }
  const stripped = trimmed.replace(/[^a-zA-Z0-9 '-]/g, "");
  const words = stripped.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) {
    return "New Session";
  }
  const titled = words
    .map((word) => {
      const cleaned = word.replace(/[^a-zA-Z0-9'-]/g, "");
      if (cleaned.length === 0) {
        return "";
      }
      const firstChar = cleaned.charAt(0);
      const rest = cleaned.slice(1);
      return firstChar.toUpperCase() + rest;
    })
    .filter((w) => w.length > 0);
  if (titled.length === 0) {
    return "New Session";
  }
  return titled.join(" ");
}

export function compareApps(left: ExternalAppSnapshot, right: ExternalAppSnapshot): number {
  const nameComparison = left.name.localeCompare(right.name);
  if (nameComparison !== 0) {
    return nameComparison;
  }

  return left.id.localeCompare(right.id);
}

export function updateActivity(
  state: SessionStoreState,
  id: string,
  patch: Partial<ActivityItem>,
): void {
  const item = state.snapshot.activity.find((entry) => entry.id === id);
  if (!item) {
    return;
  }

  Object.assign(item, patch);
}

export function updateTurn(state: SessionStoreState, next: TurnStateSnapshot): void {
  state.snapshot.turn = next;
  state.snapshot.session.updatedAt = next.updatedAt;
  state.snapshot.session.lastActivityAt = next.updatedAt;
}

export function updateTurnPhase(
  state: SessionStoreState,
  phase: AgentTurnPhase,
  message: string,
  waitingOn: TurnStateSnapshot["waitingOn"],
  updatedAt: string,
): void {
  state.snapshot.turn = {
    ...state.snapshot.turn,
    state: "running",
    phase,
    message,
    waitingOn,
    updatedAt,
  };
  state.snapshot.session.updatedAt = updatedAt;
  state.snapshot.session.lastActivityAt = updatedAt;
}
