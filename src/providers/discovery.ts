import { existsSync, type FSWatcher, readdirSync, readFileSync, watch } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

export type ProviderTransportDescriptor =
  | { type: "unix"; path: string }
  | { type: "ws"; url: string }
  | { type: "stdio"; command: string[] }
  | { type: "pipe"; name: string }
  | { type: "postmessage" };

export interface ProviderDescriptor {
  id: string;
  name: string;
  version?: string;
  slop_version?: string;
  capabilities?: string[];
  description?: string;
  transport: ProviderTransportDescriptor;
}

export interface ProviderDiscoveryUpdate {
  added: ProviderDescriptor[];
  updated: ProviderDescriptor[];
  removed: ProviderDescriptor[];
  current: ProviderDescriptor[];
}

interface WatchedDescriptor {
  descriptor: ProviderDescriptor;
  signature: string;
}

const DESCRIPTOR_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);
const DISCOVERY_DEBOUNCE_MS = 100;
const DISCOVERY_RESCAN_INTERVAL_MS = 1000;

function isProviderDescriptor(value: unknown): value is ProviderDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    !!candidate.transport &&
    typeof candidate.transport === "object"
  );
}

function readDescriptor(filePath: string): ProviderDescriptor | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed =
      filePath.endsWith(".yaml") || filePath.endsWith(".yml") ? YAML.parse(raw) : JSON.parse(raw);

    if (!isProviderDescriptor(parsed)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function hasDescriptorExtension(filePath: string): boolean {
  return [...DESCRIPTOR_EXTENSIONS].some((extension) => filePath.endsWith(extension));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );

    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

function buildDescriptorMap(descriptors: ProviderDescriptor[]): Map<string, WatchedDescriptor> {
  const entries = new Map<string, WatchedDescriptor>();

  for (const descriptor of descriptors) {
    entries.set(descriptor.id, {
      descriptor,
      signature: stableStringify(descriptor),
    });
  }

  return entries;
}

function diffDescriptorMaps(
  previous: Map<string, WatchedDescriptor>,
  next: Map<string, WatchedDescriptor>,
): ProviderDiscoveryUpdate {
  const added: ProviderDescriptor[] = [];
  const updated: ProviderDescriptor[] = [];
  const removed: ProviderDescriptor[] = [];

  for (const [id, nextEntry] of next) {
    const previousEntry = previous.get(id);
    if (!previousEntry) {
      added.push(nextEntry.descriptor);
      continue;
    }

    if (previousEntry.signature !== nextEntry.signature) {
      updated.push(nextEntry.descriptor);
    }
  }

  for (const [id, previousEntry] of previous) {
    if (!next.has(id)) {
      removed.push(previousEntry.descriptor);
    }
  }

  return {
    added,
    updated,
    removed,
    current: [...next.values()].map((entry) => entry.descriptor),
  };
}

export function discoverProviderDescriptors(paths: string[]): ProviderDescriptor[] {
  const descriptors = new Map<string, ProviderDescriptor>();

  for (const path of paths) {
    const directory = resolve(path);
    if (!existsSync(directory)) {
      continue;
    }

    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      if (!hasDescriptorExtension(entry.name)) {
        continue;
      }

      const filePath = resolve(directory, entry.name);
      const descriptor = readDescriptor(filePath);
      if (!descriptor) {
        continue;
      }

      if (!descriptors.has(descriptor.id)) {
        descriptors.set(descriptor.id, descriptor);
      }
    }
  }

  return [...descriptors.values()];
}

export function watchProviderDescriptors(options: {
  paths: string[];
  initialDescriptors?: ProviderDescriptor[];
  onChange: (update: ProviderDiscoveryUpdate) => void;
}): () => void {
  const watchers = new Map<string, FSWatcher>();
  let stopped = false;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  let currentDescriptors = buildDescriptorMap(
    options.initialDescriptors ?? discoverProviderDescriptors(options.paths),
  );

  const closeWatcher = (path: string) => {
    const watcher = watchers.get(path);
    if (!watcher) {
      return;
    }

    watcher.close();
    watchers.delete(path);
  };

  const scheduleScan = () => {
    if (stopped) {
      return;
    }

    if (scanTimer) {
      clearTimeout(scanTimer);
    }

    scanTimer = setTimeout(() => {
      scanTimer = null;
      runScan();
    }, DISCOVERY_DEBOUNCE_MS);
  };

  const refreshWatchers = () => {
    const configuredPaths = new Set(options.paths.map((path) => resolve(path)));

    for (const path of configuredPaths) {
      if (!existsSync(path)) {
        closeWatcher(path);
        continue;
      }

      if (watchers.has(path)) {
        continue;
      }

      try {
        const watcher = watch(path, (_eventType, fileName) => {
          if (typeof fileName === "string" && fileName.length > 0) {
            if (!hasDescriptorExtension(fileName)) {
              return;
            }
          }

          scheduleScan();
        });

        watcher.on("error", () => {
          closeWatcher(path);
          scheduleScan();
        });

        watchers.set(path, watcher);
      } catch {
        closeWatcher(path);
      }
    }

    for (const path of watchers.keys()) {
      if (!configuredPaths.has(path)) {
        closeWatcher(path);
      }
    }
  };

  const runScan = () => {
    if (stopped) {
      return;
    }

    refreshWatchers();

    const nextDescriptors = buildDescriptorMap(discoverProviderDescriptors(options.paths));
    const update = diffDescriptorMaps(currentDescriptors, nextDescriptors);
    currentDescriptors = nextDescriptors;

    if (update.added.length === 0 && update.updated.length === 0 && update.removed.length === 0) {
      return;
    }

    options.onChange(update);
  };

  refreshWatchers();

  const interval = setInterval(() => {
    runScan();
  }, DISCOVERY_RESCAN_INTERVAL_MS);
  interval.unref?.();

  return () => {
    stopped = true;

    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }

    clearInterval(interval);

    for (const path of watchers.keys()) {
      closeWatcher(path);
    }
  };
}
