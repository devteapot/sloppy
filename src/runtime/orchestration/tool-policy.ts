import type { SloppyConfig } from "../../config/schema";
import type { ToolPolicyDecision } from "../../core/role";
import type { RuntimeToolResolution } from "../../core/tools";

const ORCHESTRATOR_DENIED_FILESYSTEM_ACTIONS = new Set([
  "write",
  "edit",
  "mkdir",
  "delete",
  "remove",
  "move",
  "copy",
]);

const ORCHESTRATOR_SAFE_TERMINAL_COMMANDS = [
  /^npm run (build|lint|test|typecheck)$/,
  /^npm test$/,
  /^bun run (build|lint|test|typecheck)$/,
  /^bun test(?: .*)?$/,
  /^tsc(?: -b| --noEmit)?$/,
  /^vite build$/,
];

export function orchestratorToolPolicy(
  resolution: RuntimeToolResolution,
  params: Record<string, unknown>,
  _config: SloppyConfig,
): ToolPolicyDecision {
  if (resolution.kind !== "affordance") {
    return null;
  }

  if (
    resolution.providerId === "filesystem" &&
    ORCHESTRATOR_DENIED_FILESYSTEM_ACTIONS.has(resolution.action)
  ) {
    return {
      reject: `Orchestrator mode cannot call filesystem.${resolution.action} directly. Create or retry a delegated task with spawn_agent so a sub-agent performs file mutations.`,
    };
  }

  if (resolution.providerId === "delegation" && resolution.action === "spawn_agent") {
    return {
      reject: `Orchestrator mode does not spawn delegation agents directly. Create or retry orchestration tasks; the runtime scheduler starts ready tasks when dependencies and capacity allow.`,
    };
  }

  if (resolution.providerId === "terminal" && resolution.action === "execute") {
    const command = typeof params.command === "string" ? params.command.trim() : "";
    const isSafeVerification = ORCHESTRATOR_SAFE_TERMINAL_COMMANDS.some((pattern) =>
      pattern.test(command),
    );
    if (!isSafeVerification) {
      return {
        reject: `Orchestrator mode can only run simple verification commands directly (build, lint, test, typecheck). Delegate setup, install, repair, and shell-composed commands to a sub-agent.`,
      };
    }
  }

  return null;
}
