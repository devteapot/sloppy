import { Text } from "@earendil-works/pi-tui";

import type { SessionViewSnapshot } from "../backend/slop-types";
import { projectIndicators } from "../state/manifest-projection";

export type InteractionMode = "default" | "auto-approve" | "plan";

export class StatusLine extends Text {
  update(snapshot: SessionViewSnapshot, mode: InteractionMode): void {
    const workspace = snapshot.session.workspaceRoot ?? "workspace";
    const model = [snapshot.session.modelProvider, snapshot.session.model]
      .filter(Boolean)
      .join("/");
    const turn = `${snapshot.turn.state}:${snapshot.turn.phase}`;
    const indicators = projectIndicators(snapshot)
      .map((indicator) => indicator.text)
      .filter(Boolean);
    this.setText(
      [workspace, model || "model unset", turn, `mode ${mode}`, ...indicators].join(" | "),
    );
  }
}
