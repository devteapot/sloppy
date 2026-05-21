import { Text } from "@earendil-works/pi-tui";

import type { SessionViewSnapshot } from "../backend/slop-types";
import { projectIndicators } from "../state/manifest-projection";
import { formatHomePath } from "./display-path";

export type InteractionMode = "default" | "auto-approve" | "plan";

export class StatusLine extends Text {
  constructor() {
    super("", 1, 0);
  }

  update(snapshot: SessionViewSnapshot, _mode: InteractionMode): void {
    const workspace = snapshot.session.workspaceRoot
      ? formatHomePath(snapshot.session.workspaceRoot)
      : "workspace";
    const model = [snapshot.session.modelProvider, snapshot.session.model]
      .filter(Boolean)
      .join("/");
    const turn = `${snapshot.turn.state}:${snapshot.turn.phase}`;
    const indicators = projectIndicators(snapshot)
      .map((indicator) => indicator.text)
      .filter(Boolean);
    this.setText(
      [workspace, model || "model unset", turn, ...indicators].filter(Boolean).join(" | "),
    );
  }
}
