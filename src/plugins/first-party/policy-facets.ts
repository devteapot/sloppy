import type { SloppyConfig } from "../../config/schema";
import type { InvokePolicy } from "../../core/policy";
import { FIRST_PARTY_PLUGIN_BY_ID, isFirstPartyPluginEnabled } from "./manifest";
import { terminalSafetyRule } from "./terminal/policy";

export function createFirstPartyPluginPolicyRules(config: SloppyConfig): InvokePolicy[] {
  const terminal = FIRST_PARTY_PLUGIN_BY_ID.get("terminal");
  return terminal && isFirstPartyPluginEnabled(config, terminal) ? [terminalSafetyRule] : [];
}
