import type { SloppyConfig } from "./schema";

/**
 * Flip the three orchestrator-role builtin providers (`delegation`,
 * `orchestration`, `spec`) to `true` while leaving the rest of the
 * configuration untouched. The orchestrator role is a no-op without these
 * providers, so callers that opt into it bundle the flags via this helper.
 */
export function withOrchestratorBuiltins(config: SloppyConfig): SloppyConfig {
  return {
    ...config,
    providers: {
      ...config.providers,
      builtin: {
        ...config.providers.builtin,
        delegation: true,
        orchestration: true,
        spec: true,
      },
    },
  };
}
