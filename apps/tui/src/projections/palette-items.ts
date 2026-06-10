import type { SessionViewSnapshot, TuiRoute } from "../backend/slop-types";
import type { SupervisorSnapshot } from "../backend/supervisor-client";
import type { LocalCommand } from "./command-types";
import { projectPluginActions } from "./manifest-projection";

export type PaletteCommand = {
  id: string;
  label: string;
  description?: string;
  command: LocalCommand;
};

const ROUTES: TuiRoute[] = ["chat", "setup", "approvals", "tasks", "apps", "inspect", "runtime"];

export function buildCommandPaletteCommands(
  snapshot: SessionViewSnapshot,
  supervisor?: SupervisorSnapshot | null,
): PaletteCommand[] {
  const commands: PaletteCommand[] = ROUTES.map((route) => ({
    id: `route:${route}`,
    label: `Open ${route}`,
    command: route === "inspect" ? { type: "inspect_open" } : { type: "route", route },
  }));
  commands.push({
    id: "approval-mode:toggle",
    label: "Toggle approval mode",
    description: "Switch the session between normal and auto approvals",
    command: { type: "approval_mode", mode: "toggle" },
  });
  commands.push({
    id: "config:reload-session",
    label: "Reload session config",
    description: "Reload config for the selected session",
    command: { type: "config_reload", target: "session" },
  });
  if (supervisor) {
    commands.push({
      id: "config:reload-supervisor",
      label: "Reload supervisor config",
      description: "Refresh supervisor config and available scopes",
      command: { type: "config_reload", target: "supervisor" },
    });
  }

  for (const item of snapshot.queue) {
    if (item.canCancel) {
      commands.push({
        id: `queue:${item.id}`,
        label: `Cancel queued #${item.position}`,
        description: item.summary,
        command: { type: "queue_cancel", target: item.id },
      });
    }
  }

  for (const approval of snapshot.approvals) {
    if (approval.canApprove) {
      commands.push({
        id: `approval:${approval.id}:approve`,
        label: `Approve ${approval.provider}.${approval.action}`,
        description: approval.reason,
        command: {
          type: "invoke",
          targetId: "session",
          path: `/approvals/${approval.id}`,
          action: "approve",
        },
      });
    }
    if (approval.canReject) {
      commands.push({
        id: `approval:${approval.id}:reject`,
        label: `Reject ${approval.provider}.${approval.action}`,
        description: approval.reason,
        command: {
          type: "invoke",
          targetId: "session",
          path: `/approvals/${approval.id}`,
          action: "reject",
        },
      });
    }
  }

  for (const task of snapshot.tasks) {
    if (task.canCancel) {
      commands.push({
        id: `task:${task.id}:cancel`,
        label: `Cancel task ${task.providerTaskId}`,
        description: task.message,
        command: {
          type: "invoke",
          targetId: "session",
          path: `/tasks/${task.id}`,
          action: "cancel",
        },
      });
    }
  }

  for (const projected of projectPluginActions(snapshot)) {
    if (!projected.available || projected.action.argument) {
      continue;
    }
    commands.push({
      id: `plugin:${projected.pluginId}:${projected.action.id}`,
      label: projected.action.label,
      description: projected.action.description,
      command: {
        type: "plugin_action",
        pluginId: projected.pluginId,
        actionId: projected.action.id,
        label: projected.action.label,
        path: projected.action.invoke.path,
        action: projected.action.invoke.action,
        params: projected.action.invoke.params,
      },
    });
  }

  for (const session of supervisor?.sessions ?? []) {
    if (session.canSwitch) {
      commands.push({
        id: `session:${session.id}:switch`,
        label: `Switch session ${session.title ?? session.id}`,
        description: session.goalObjective ?? session.turnMessage,
        command: { type: "session_switch", sessionId: session.id },
      });
    }
    if (session.canStop && snapshot.session.sessionId !== session.id) {
      commands.push({
        id: `session:${session.id}:stop`,
        label: `Stop session ${session.title ?? session.id}`,
        command: { type: "session_stop", sessionId: session.id },
      });
    }
  }

  for (const scope of supervisor?.scopes ?? []) {
    if (scope.canCreate) {
      commands.push({
        id: `scope:${scope.id}:new`,
        label: `New session in ${scope.name}`,
        description: scope.root,
        command: {
          type: "session_new",
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          title: scope.name,
        },
      });
    }
  }

  return commands;
}
