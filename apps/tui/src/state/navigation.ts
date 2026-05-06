import type { TuiRoute } from "../slop/types";

export type NavigationItem = {
  route: TuiRoute;
  label: string;
  shortcut: string;
};

export const NAVIGATION_ITEMS: NavigationItem[] = [
  { route: "chat", label: "Chat", shortcut: "Ctrl+P/N" },
  { route: "setup", label: "Setup", shortcut: "/setup" },
  { route: "approvals", label: "Approvals", shortcut: "/approvals" },
  { route: "tasks", label: "Tasks", shortcut: "/tasks" },
  { route: "apps", label: "Apps", shortcut: "/apps" },
  { route: "runtime", label: "Runtime", shortcut: "/runtime" },
];
