import type { SupervisorSnapshot } from "../slop/supervisor-client";
import type { SessionViewSnapshot } from "../slop/types";
import type { LocalCommand } from "./commands";
import { NAVIGATION_ITEMS } from "./navigation";

export type PaletteCommand = {
  id: string;
  label: string;
  description: string;
  shortcut?: string;
  command: LocalCommand;
};

export function buildCommandPaletteCommands(
  snapshot: SessionViewSnapshot,
  mouseEnabled: boolean,
  supervisor?: SupervisorSnapshot,
): PaletteCommand[] {
  const commands: PaletteCommand[] = [
    ...NAVIGATION_ITEMS.map(
      (item): PaletteCommand => ({
        id: `route:${item.route}`,
        label: `Open ${item.label}`,
        description: `Switch to the ${item.label.toLowerCase()} route`,
        shortcut: item.shortcut,
        command: { type: "route", route: item.route },
      }),
    ),
    {
      id: "inspect:open",
      label: "Open Inspector",
      description: "Browse SLOP state trees",
      shortcut: "/inspect",
      command: { type: "inspect_open" },
    },
    {
      id: "help",
      label: "Open Help",
      description: "Show hotkeys and slash commands",
      shortcut: "/help",
      command: { type: "help" },
    },
    {
      id: "verbosity:cycle",
      label: "Cycle Verbosity",
      description: "compact ↔ normal ↔ verbose",
      shortcut: "/verbosity",
      command: { type: "verbosity", mode: "cycle" },
    },
    {
      id: "verbosity:compact",
      label: "Verbosity: Compact",
      description: "Hide tool calls; show only messages",
      command: { type: "verbosity", mode: "compact" },
    },
    {
      id: "verbosity:normal",
      label: "Verbosity: Normal",
      description: "Active turn tools inline; past turns collapsed",
      command: { type: "verbosity", mode: "normal" },
    },
    {
      id: "verbosity:verbose",
      label: "Verbosity: Verbose",
      description: "All tool calls expanded with previews",
      command: { type: "verbosity", mode: "verbose" },
    },
    {
      id: "mouse:toggle",
      label: mouseEnabled ? "Disable Mouse Mode" : "Enable Mouse Mode",
      description: mouseEnabled
        ? "Restore terminal text selection behavior"
        : "Enable mouse reporting inside the TUI",
      shortcut: "/mouse",
      command: { type: "mouse", mode: mouseEnabled ? "off" : "on" },
    },
    {
      id: "goal:show",
      label: "Show Goal",
      description: snapshot.goal.exists
        ? `Current goal is ${snapshot.goal.status}`
        : "No active runtime goal",
      command: { type: "goal", action: "show" },
    },
  ];

  if (snapshot.goal.canPause) {
    commands.push({
      id: "goal:pause",
      label: "Pause Goal",
      description: "Pause automatic goal continuation",
      command: { type: "goal", action: "pause" },
    });
  }
  if (snapshot.goal.canResume) {
    commands.push({
      id: "goal:resume",
      label: "Resume Goal",
      description: "Resume automatic goal continuation",
      command: { type: "goal", action: "resume" },
    });
  }
  if (snapshot.goal.canComplete) {
    commands.push({
      id: "goal:complete",
      label: "Complete Goal",
      description: "Mark the active goal complete",
      command: { type: "goal", action: "complete" },
    });
  }
  if (snapshot.goal.canClear) {
    commands.push({
      id: "goal:clear",
      label: "Clear Goal",
      description: "Clear the active goal state",
      command: { type: "goal", action: "clear" },
    });
  }

  for (const item of snapshot.queue) {
    if (!item.canCancel) {
      continue;
    }
    commands.push({
      id: `queue:${item.id}`,
      label: `Cancel Queue #${item.position}`,
      description: item.summary,
      command: { type: "queue_cancel", target: item.id },
    });
  }

  for (const app of snapshot.apps) {
    commands.push({
      id: `app:${app.id}:inspect`,
      label: `Inspect ${app.name}`,
      description: `${app.transport} provider state`,
      command: {
        type: "query",
        path: "/",
        depth: 2,
        targetId: app.id,
      },
    });
  }

  if (supervisor?.connection.status === "connected") {
    for (const scope of supervisor.scopes) {
      if (!scope.canCreate) {
        continue;
      }
      commands.push({
        id: `session:new:${scope.id}`,
        label: `New Session: ${scope.name}`,
        description: scope.projectId
          ? `${scope.workspaceId}/${scope.projectId} at ${scope.root}`
          : `${scope.workspaceId} at ${scope.root}`,
        command: {
          type: "session_new",
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          title: scope.name,
        },
      });
    }

    for (const session of supervisor.sessions) {
      const sessionScope = session.projectId
        ? `${session.workspaceId}/${session.projectId}`
        : (session.workspaceId ?? session.socketPath);
      if (session.canSwitch && !session.selected) {
        commands.push({
          id: `session:switch:${session.id}`,
          label: `Switch Session: ${session.title ?? session.id}`,
          description: `${sessionScope} · turn=${session.turnState ?? "unknown"} goal=${session.goalStatus ?? "none"}`,
          command: { type: "session_switch", sessionId: session.id },
        });
      }
      if (session.canStop) {
        commands.push({
          id: `session:stop:${session.id}`,
          label: `Stop Session: ${session.title ?? session.id}`,
          description: session.socketPath,
          command: { type: "session_stop", sessionId: session.id },
        });
      }
    }
  }

  return commands;
}
