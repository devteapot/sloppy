import { createPersistentGoalPlugin } from "./persistent-goal";
import type { SessionRuntimePlugin } from "./types";

export { SessionPluginManager } from "./manager";
export type {
  ActivePluginTurn,
  PluginRuntimeContext,
  PluginTurnCompleteEvent,
  PluginTurnFailureEvent,
  PluginTurnRequest,
  SessionNodeContribution,
  SessionRuntimePlugin,
  TuiContributionManifest,
} from "./types";

export function createBuiltinSessionPlugins(): SessionRuntimePlugin[] {
  return [createPersistentGoalPlugin()];
}
