import type {
  PluginActionContribution,
  PluginIndicatorContribution,
  PluginItem,
  SessionViewSnapshot,
} from "../backend/slop-types";

export type ProjectedPluginAction = {
  pluginId: string;
  action: PluginActionContribution;
  available: boolean;
};

export type ProjectedIndicator = {
  pluginId: string;
  indicator: PluginIndicatorContribution;
  text: string;
  severity?: string;
};

function actionAvailable(snapshot: SessionViewSnapshot, action: PluginActionContribution): boolean {
  const required = action.whenAvailable ?? action.invoke.action;
  return (snapshot.actionsByPath[action.invoke.path] ?? []).includes(required);
}

export function projectPluginActions(snapshot: SessionViewSnapshot): ProjectedPluginAction[] {
  return snapshot.plugins.flatMap((plugin) =>
    (plugin.ui.actions ?? []).map((action) => ({
      pluginId: plugin.id,
      action,
      available: actionAvailable(snapshot, action),
    })),
  );
}

function readObjectProperty(source: unknown, key: string): unknown {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  return record[key] ?? record[key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase())];
}

export function readSnapshotPath(snapshot: SessionViewSnapshot, path: string): unknown {
  let current: unknown = snapshot;
  for (const segment of path.split("/").filter(Boolean)) {
    current = readObjectProperty(current, segment);
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

function formatValue(value: unknown, format: string | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (format === "number" && typeof value === "number") {
    return value.toLocaleString();
  }
  if (format === "percent" && typeof value === "number") {
    return `${Math.round(value * 100)}%`;
  }
  if (format === "duration" && typeof value === "number") {
    return `${Math.round(value / 1000)}s`;
  }
  if (format === "bytes" && typeof value === "number") {
    return `${value.toLocaleString()} B`;
  }
  return String(value);
}

function renderTemplate(
  template: string,
  source: unknown,
  fields: PluginIndicatorContribution["fields"],
): string {
  return template.replace(/\{([^}]+)\}/g, (_, rawName: string) => {
    const name = rawName.trim();
    return formatValue(readObjectProperty(source, name), fields?.[name]?.format);
  });
}

function indicatorVisible(indicator: PluginIndicatorContribution, source: unknown): boolean {
  if (!indicator.visibleWhen) {
    return true;
  }
  const value = readObjectProperty(source, indicator.visibleWhen.prop);
  return "equals" in indicator.visibleWhen
    ? value === indicator.visibleWhen.equals
    : Boolean(value);
}

export function projectIndicators(snapshot: SessionViewSnapshot): ProjectedIndicator[] {
  return snapshot.plugins.flatMap((plugin: PluginItem) =>
    (plugin.ui.indicators ?? []).flatMap((indicator): ProjectedIndicator[] => {
      const source = readSnapshotPath(snapshot, indicator.path);
      if (!source || !indicatorVisible(indicator, source)) {
        return [];
      }
      const severityValue = indicator.severity
        ? readObjectProperty(source, indicator.severity.prop)
        : undefined;
      return [
        {
          pluginId: plugin.id,
          indicator,
          text: renderTemplate(indicator.template, source, indicator.fields),
          severity:
            severityValue === undefined
              ? undefined
              : indicator.severity?.map[String(severityValue)],
        },
      ];
    }),
  );
}
