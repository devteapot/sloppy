import type { ExternalAppSnapshot } from "../types";
import { compareApps, now } from "./helpers";
import type { SessionStoreState } from "./state";

export function syncApps(state: SessionStoreState, apps: ExternalAppSnapshot[]): void {
  state.snapshot.apps = apps.map((app) => ({ ...app })).sort(compareApps);
  state.snapshot.session.updatedAt = now();
  state.appsChanged = true;
  state.sessionChanged = true;
}
