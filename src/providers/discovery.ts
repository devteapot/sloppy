import { resolve } from "node:path";
import YAML from "yaml";

import { validateDescriptor } from "./descriptor-validation";

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
const DISCOVERY_RESCAN_INTERVAL_MS = 250;

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

async function readDescriptor(filePath: string): Promise<ProviderDescriptor | null> {
  try {
    const raw = await Bun.file(filePath).text();
    const parsed =
      filePath.endsWith(".yaml") || filePath.endsWith(".yml") ? YAML.parse(raw) : JSON.parse(raw);

    if (!isProviderDescriptor(parsed)) {
      console.warn(
        `[provider-discovery] skipping invalid descriptor ${filePath}: missing required fields (id, name, transport)`,
      );
      return null;
    }

    const validation = validateDescriptor(parsed);

    if ("errors" in validation) {
      console.warn(
        `[provider-discovery] skipping descriptor ${filePath}: ${validation.errors.join(", ")}`,
      );
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

export async function discoverProviderDescriptors(paths: string[]): Promise<ProviderDescriptor[]> {
  const descriptors = new Map<string, ProviderDescriptor>();

  for (const path of paths) {
    const directory = resolve(path);
    const directoryInfo = await Bun.file(directory)
      .stat()
      .catch(() => null);
    if (!directoryInfo?.isDirectory()) {
      continue;
    }

    for (const filePath of new Bun.Glob("*").scanSync({ cwd: directory, absolute: true })) {
      if (!hasDescriptorExtension(filePath)) {
        continue;
      }

      const descriptor = await readDescriptor(filePath);
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
  let stopped = false;
  let currentDescriptors = buildDescriptorMap(options.initialDescriptors ?? []);
  let runningScan: Promise<void> | null = null;

  const runScan = () => {
    if (stopped) {
      return;
    }

    if (runningScan) {
      return;
    }

    runningScan = (async () => {
      const nextDescriptors = buildDescriptorMap(await discoverProviderDescriptors(options.paths));
      const update = diffDescriptorMaps(currentDescriptors, nextDescriptors);
      currentDescriptors = nextDescriptors;

      if (update.added.length === 0 && update.updated.length === 0 && update.removed.length === 0) {
        return;
      }

      options.onChange(update);
    })().finally(() => {
      runningScan = null;
    });
  };

  runScan();

  const interval = setInterval(() => {
    runScan();
  }, DISCOVERY_RESCAN_INTERVAL_MS);
  interval.unref?.();

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
