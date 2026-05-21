import { Text } from "@earendil-works/pi-tui";

import type { SessionViewSnapshot } from "../backend/slop-types";

export class StatusLine extends Text {
  update(snapshot: SessionViewSnapshot): void {
    const workspace = snapshot.session.workspaceRoot ?? "workspace";
    const model = [snapshot.session.modelProvider, snapshot.session.model]
      .filter(Boolean)
      .join("/");
    const turn = `${snapshot.turn.state}:${snapshot.turn.phase}`;
    this.setText(`${workspace} | ${model || "model unset"} | ${turn} | default`);
  }
}
