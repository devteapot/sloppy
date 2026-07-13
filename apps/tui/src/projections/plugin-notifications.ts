import type { PluginNotificationContribution, SessionViewSnapshot } from "../backend/slop-types";
import { readObjectPath, readObjectProperty } from "./object-path";

export type RuntimePluginNotification = PluginNotificationContribution & {
  pluginId: string;
};

export type TriggeredPluginNotification = RuntimePluginNotification & {
  key: string;
};

function collectPluginNotifications(snapshot: SessionViewSnapshot): RuntimePluginNotification[] {
  return snapshot.plugins.flatMap((plugin) =>
    (plugin.ui.notifications ?? []).map((notification) => ({
      ...notification,
      pluginId: plugin.id,
    })),
  );
}

// exported for tests
export function readPluginNotificationValue(
  snapshot: SessionViewSnapshot,
  source: string,
  field?: string,
): string | undefined {
  const sourceValue = readObjectPath(snapshot, source);
  const value = field ? readObjectProperty(sourceValue, field) : sourceValue;
  if (value === null || value === undefined) {
    return undefined;
  }
  return String(value);
}

function renderMessage(template: string, source: unknown): string {
  return template.replace(/\{([^}]+)\}/g, (_, rawName: string) => {
    const value = readObjectProperty(source, rawName.trim());
    return value === null || value === undefined ? "" : String(value);
  });
}

export function evaluatePluginNotifications(
  snapshot: SessionViewSnapshot,
  previousValues: Map<string, string | undefined>,
): TriggeredPluginNotification[] {
  const triggered: TriggeredPluginNotification[] = [];
  const activeKeys = new Set<string>();

  for (const notification of collectPluginNotifications(snapshot)) {
    const key = `${notification.pluginId}:${notification.id}`;
    activeKeys.add(key);
    const source = readObjectPath(snapshot, notification.source);
    const nextValue = readPluginNotificationValue(
      snapshot,
      notification.source,
      notification.field,
    );
    const previousValue = previousValues.get(key);
    if (
      previousValue !== undefined &&
      previousValue !== notification.to &&
      nextValue === notification.to
    ) {
      triggered.push({
        ...notification,
        message: renderMessage(notification.message, source),
        key,
      });
    }
    previousValues.set(key, nextValue);
  }

  for (const key of previousValues.keys()) {
    if (!activeKeys.has(key)) {
      previousValues.delete(key);
    }
  }

  return triggered;
}
