import type { SessionClientEvent } from "../backend/slop-types";
import type { SupervisorClientEvent } from "../backend/supervisor-client";
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

export function handleSupervisorEvent(app: AppUi, event: SupervisorClientEvent): void {
  if (event.type === "snapshot") {
    app.updateSupervisor(event.snapshot);
    return;
  }
  if (event.type === "error") {
    app.setNotice(event.message);
  }
}
