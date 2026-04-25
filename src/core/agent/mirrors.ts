// Provider mirror registration helpers used by Agent. Watches the configured
// mirror paths for a provider and surfaces snapshots through the supplied
// callback. Stop functions are tracked in a caller-owned Map so the Agent
// retains lifecycle authority without inlining the subscription plumbing.

import type { SlopNode } from "@slop-ai/consumer/browser";

import type { ProviderRuntimeHub } from "../hub";

export type ProviderSnapshot = {
  providerId: string;
  path: string;
  tree: SlopNode | null;
};

export interface MirrorRegisterArgs {
  hub: ProviderRuntimeHub;
  providerId: string;
  paths: readonly string[];
  watchStops: Map<string, Array<() => void>>;
  onSnapshot?: (snapshot: ProviderSnapshot) => void;
}

export async function registerProviderMirrors(args: MirrorRegisterArgs): Promise<void> {
  const { hub, providerId, paths, watchStops, onSnapshot } = args;
  if (watchStops.has(providerId) || paths.length === 0) {
    return;
  }

  const stops = await Promise.all(
    paths.map((path) =>
      hub.watchPath(
        providerId,
        path,
        (tree) => {
          onSnapshot?.({ providerId, path, tree });
        },
        { depth: 2 },
      ),
    ),
  );
  watchStops.set(providerId, stops);
}

export function unregisterProviderMirrors(args: {
  providerId: string;
  paths: readonly string[];
  watchStops: Map<string, Array<() => void>>;
  onSnapshot?: (snapshot: ProviderSnapshot) => void;
}): void {
  const { providerId, paths, watchStops, onSnapshot } = args;
  const stops = watchStops.get(providerId);
  if (!stops) {
    return;
  }

  for (const stop of stops) {
    stop();
  }
  watchStops.delete(providerId);
  for (const path of paths) {
    onSnapshot?.({ providerId, path, tree: null });
  }
}
