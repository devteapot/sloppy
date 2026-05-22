import type { PluginNotificationContribution, SessionViewSnapshot } from "../backend/slop-types";

export type RuntimePluginNotification = PluginNotificationContribution & {
  pluginId: string;
};

export type TriggeredPluginNotification = RuntimePluginNotification & {
  key: string;
};

function toCamelCase(value: string): string {
  return value.replace(/[-_]([a-zA-Z0-9])/g, (_, char: string) => char.toUpperCase());
}

function readObjectProperty(source: unknown, key: string): unknown {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  return record[key] ?? record[toCamelCase(key)];
}

export function collectPluginNotifications(
  snapshot: SessionViewSnapshot,
): RuntimePluginNotification[] {
  return snapshot.plugins.flatMap((plugin) =>
    (plugin.ui.notifications ?? []).map((notification) => ({
      ...notification,
      pluginId: plugin.id,
    })),
  );
}

export function readPluginNotificationValue(
  snapshot: SessionViewSnapshot,
  path: string,
  prop: string,
): string | undefined {
  const segments = path.split("/").filter(Boolean);
  let current: unknown = snapshot;
  for (const segment of segments) {
    current = readObjectProperty(current, segment);
    if (current === undefined) {
      return undefined;
    }
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
