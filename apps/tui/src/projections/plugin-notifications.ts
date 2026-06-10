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
  path: string,
  prop: string,
): string | undefined {
  const current = readObjectPath(snapshot, path);
  if (current === undefined) {
    return undefined;
  }

  const value = readObjectProperty(current, prop);
  if (value === null || value === undefined) {
    return undefined;
  }
  return String(value);
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
    const nextValue = readPluginNotificationValue(
      snapshot,
      notification.source.path,
      notification.source.prop,
    );
    const previousValue = previousValues.get(key);
    if (
      previousValue !== undefined &&
      previousValue !== notification.to &&
      nextValue === notification.to
    ) {
      triggered.push({ ...notification, key });
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
