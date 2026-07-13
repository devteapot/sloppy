import type { RuntimeCapabilityMask } from "../../../core/capability-policy";
import type { RouteMessageEnvelope } from "../shared/message-envelope";
import type { ExecutorBinding } from "./runtime/executor-binding";

export type DelegationSpawnRequest = {
  name: string;
  goal: string;
  executor?: ExecutorBinding;
  capabilityMasks?: RuntimeCapabilityMask[];
  routeEnvelope?: RouteMessageEnvelope;
};

export type DelegationSpawnResult = {
  id: string;
  status: string;
  created_at: string;
  execution_mode: string;
  session_provider_id?: string;
};

export interface DelegationService {
  spawnAgent(request: DelegationSpawnRequest): DelegationSpawnResult;
}
