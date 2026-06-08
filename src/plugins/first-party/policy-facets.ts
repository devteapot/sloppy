import type { SloppyConfig } from "../../config/schema";
import type { InvokePolicy } from "../../core/policy";
import { FIRST_PARTY_PLUGIN_BY_ID, isFirstPartyPluginEnabled } from "./manifest";
import { terminalSafetyRule } from "./terminal/policy";
import { voiceNetworkRule } from "./voice/policy";

export function createFirstPartyPluginPolicyRules(config: SloppyConfig): InvokePolicy[] {
  const terminal = FIRST_PARTY_PLUGIN_BY_ID.get("terminal");
  const voice = FIRST_PARTY_PLUGIN_BY_ID.get("voice");
  return [
    ...(terminal && isFirstPartyPluginEnabled(config, terminal) ? [terminalSafetyRule] : []),
    ...(voice && isFirstPartyPluginEnabled(config, voice) ? [voiceNetworkRule] : []),
  ];
}
