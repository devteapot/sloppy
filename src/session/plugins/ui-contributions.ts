export type UiContributionSubscription = {
  path: string;
  depth: number;
};

export type UiContributionInvoke = {
  path: string;
  action: string;
  params?: Record<string, unknown>;
};

export type UiContributionActionArgument = {
  name: string;
  description?: string;
  required?: boolean;
  param?: string;
};

export type UiContributionAction = {
  id: string;
  label: string;
  description: string;
  invoke: UiContributionInvoke;
  whenAvailable?: string;
  argument?: UiContributionActionArgument;
  presentation?: {
    tui?: Record<string, unknown>;
    web?: Record<string, unknown>;
    voice?: Record<string, unknown>;
  };
};

export type UiContributionNotification = {
  id: string;
  source: {
    path: string;
    prop: string;
  };
  to: string;
  message: string;
};

export type UiContributionFieldFormat = "text" | "number" | "duration" | "percent" | "bytes";

export type UiContributionIndicator = {
  id: string;
  path: string;
  depth?: number;
  template: string;
  fields?: Record<string, { format: UiContributionFieldFormat }>;
  visibleWhen?: {
    prop: string;
    equals?: unknown;
  };
  severity?: {
    prop: string;
    map: Record<string, string>;
  };
};

export type UiContributionManifest = {
  subscriptions?: UiContributionSubscription[];
  actions?: UiContributionAction[];
  notifications?: UiContributionNotification[];
  indicators?: UiContributionIndicator[];
};
