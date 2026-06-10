import type { ApprovalMode, TuiRoute } from "../backend/slop-types";

export type Verbosity = "compact" | "verbose";

export type LocalCommand =
  | { type: "route"; route: TuiRoute }
  | { type: "inspect_open" }
  | { type: "help" }
  | { type: "clear" }
  | { type: "quit" }
  | { type: "verbosity"; mode: Verbosity | "show" }
  | { type: "approval_mode"; mode: ApprovalMode | "show" | "toggle" }
  | {
      type: "goal";
      action: "show" | "create" | "pause" | "resume" | "complete" | "clear";
      objective?: string;
      tokenBudget?: number;
      message?: string;
    }
  | {
      type: "runtime";
      action: "refresh" | "export" | "inspect" | "apply" | "revert";
      proposalId?: string;
    }
  | {
      type: "query";
      path: string;
      depth: number;
      targetId: string;
      window?: [number, number];
      maxNodes?: number;
    }
  | {
      type: "invoke";
      path: string;
      action: string;
      params?: Record<string, unknown>;
      targetId: string;
    }
  | {
      type: "plugin_action";
      pluginId: string;
      actionId: string;
      label: string;
      path: string;
      action: string;
      params?: Record<string, unknown>;
    }
  | {
      type: "profile";
      profileId?: string;
      label?: string;
      kind?: "native" | "session-agent";
      endpointId?: string;
      model?: string;
      reasoningEffort?: string;
      thinkingEnabled?: boolean;
      thinkingDisplay?: "visible" | "hidden";
      adapterId?: string;
      makeDefault: boolean;
    }
  | {
      type: "profile_secret";
      profileId?: string;
      label?: string;
      kind?: "native" | "session-agent";
      endpointId?: string;
      model?: string;
      reasoningEffort?: string;
      thinkingEnabled?: boolean;
      thinkingDisplay?: "visible" | "hidden";
      adapterId?: string;
      makeDefault: boolean;
    }
  | { type: "rejected"; reason: string }
  | { type: "queue_cancel"; target: string | number }
  | { type: "config_reload"; target: "session" | "supervisor" }
  | {
      type: "session_new";
      workspaceId?: string;
      projectId?: string;
      title?: string;
      sessionId?: string;
    }
  | { type: "session_switch"; sessionId: string }
  | { type: "session_stop"; sessionId: string }
  | { type: "unknown"; name: string };
