import type { AgentSessionSnapshot } from "../types";
import type { PluginRuntimeContext } from "./types";

export type ClientContributionActionArgument = {
  name: string;
  description?: string;
  required?: boolean;
  param?: string;
};

export type ClientContributionAction = {
  id: string;
  label: string;
  description: string;
  command: string;
  available: boolean;
  argument?: ClientContributionActionArgument;
  presentation?: Record<string, Record<string, unknown>>;
};

export type ClientContributionIndicator = {
  id: string;
  source: string;
  template: string;
  fields?: Record<string, { format: "text" | "number" | "duration" | "percent" | "bytes" }>;
  visibleWhen?: { field: string; equals?: unknown };
  severity?: { field: string; map: Record<string, string> };
};

export type ClientContributionNotification = {
  id: string;
  source: string;
  field?: string;
  to: unknown;
  message: string;
};

export type ClientContributionManifest = {
  actions: ClientContributionAction[];
  indicators: ClientContributionIndicator[];
  notifications: ClientContributionNotification[];
};

export type ClientCommandContribution = {
  id: string;
  available?: (snapshot: AgentSessionSnapshot) => boolean;
  execute: (
    ctx: PluginRuntimeContext,
    params: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
};

export type ClientContributionDefinition = {
  actions?: Array<Omit<ClientContributionAction, "available">>;
  indicators?: ClientContributionIndicator[];
  notifications?: ClientContributionNotification[];
};
