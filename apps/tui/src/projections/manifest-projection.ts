import type {
  PluginActionContribution,
  PluginIndicatorContribution,
  PluginItem,
  SessionViewSnapshot,
} from "../backend/slop-types";
import { readObjectPath, readObjectProperty } from "./object-path";

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

function actionAvailable(
  _snapshot: SessionViewSnapshot,
  action: PluginActionContribution,
): boolean {
  return action.available;
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
  const value = readObjectProperty(source, indicator.visibleWhen.field);
  return "equals" in indicator.visibleWhen
    ? value === indicator.visibleWhen.equals
    : Boolean(value);
}

export function projectIndicators(snapshot: SessionViewSnapshot): ProjectedIndicator[] {
  return snapshot.plugins.flatMap((plugin: PluginItem) =>
    (plugin.ui.indicators ?? []).flatMap((indicator): ProjectedIndicator[] => {
      const source = readObjectPath(snapshot, indicator.source);
      if (!source || !indicatorVisible(indicator, source)) {
        return [];
      }
      const severityValue = indicator.severity
        ? readObjectProperty(source, indicator.severity.field)
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
