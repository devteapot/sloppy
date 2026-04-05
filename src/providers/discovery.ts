import { existsSync, readdirSync, readFileSync } from "node:fs";
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
