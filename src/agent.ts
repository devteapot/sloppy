import { type AgentOptions, Agent as CoreAgent } from "./core/agent";
import { createDefaultChildSession } from "./session/runtime";

export type {
  AgentCallbacks,
  AgentOptions,
  AgentRunResult,
  ResolvedApprovalToolResult,
} from "./core/agent";

/**
 * Public Agent composition with the default session-backed delegation runtime.
 * Core embedders may import `core/agent` and supply their own child factory.
 */
export class Agent extends CoreAgent {
  constructor(options: AgentOptions = {}) {
    super({
      ...options,
      childSessionFactory: options.childSessionFactory ?? createDefaultChildSession,
    });
  }
}
