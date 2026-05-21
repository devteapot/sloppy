import type { SessionClientEvent } from "../backend/slop-types";
import type { AppUi } from "../ui/app";

export function handleSessionEvent(app: AppUi, event: SessionClientEvent): void {
  if (event.type === "snapshot") {
    app.update(event.snapshot);
    return;
  }
  if (event.type === "error") {
    app.setNotice(event.message);
  }
}
