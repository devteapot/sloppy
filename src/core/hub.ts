// Narrow consumer-side hub interface that external callers (loop, agent,
// runtime/delegation, providers) should depend on
// instead of the concrete `ConsumerHub` class. The class implements this
// interface; keeping the surface small is what enforces the "thin core, fat
// providers" boundary documented in CLAUDE.md and docs/02-architecture.md.

import type { ResultMessage, SlopNode } from "@slop-ai/consumer/browser";
import type { RegisteredProvider } from "../providers/registry";
import type { ApprovalQueue } from "./approvals";
import type { ExternalProviderState, ProviderEvent } from "./consumer";
import type { InvocationMetadata, InvokePolicy } from "./policy";
import type { ProviderTreeView } from "./subscriptions";
import type { RuntimeToolSet } from "./tools";

export interface ProviderRuntimeHub {
  readonly approvals: ApprovalQueue;

  // Provider lifecycle
  addProvider(registeredProvider: RegisteredProvider): Promise<boolean>;
  removeProvider(providerId: string): void;
  shutdown(): void;

  // State queries / subscriptions
  queryState(options: {
    providerId: string;
    path: string;
    depth?: number;
    maxNodes?: number;
    minSalience?: number;
    window?: [number, number];
  }): Promise<SlopNode>;
  focusState(options: {
    providerId: string;
    path: string;
    depth?: number;
    maxNodes?: number;
  }): Promise<SlopNode>;
  watchPath(
    providerId: string,
    path: string,
    listener: (tree: SlopNode | null) => void,
    options?: { depth?: number; maxNodes?: number },
  ): Promise<() => void>;

  // Affordance invocation
  invoke(
    providerId: string,
    path: string,
    action: string,
    params?: Record<string, unknown>,
    metadata?: InvocationMetadata,
  ): Promise<ResultMessage>;

  // Tool / view derivations
  getProviderViews(): ProviderTreeView[];
  getRuntimeToolSet(): RuntimeToolSet;

  // External provider observability
  getExternalProviderStates(): ExternalProviderState[];
  onExternalProviderStateChange(listener: (states: ExternalProviderState[]) => void): () => void;
  onProviderEvent(listener: (event: ProviderEvent) => void): () => void;

  // State revision (used by delegation/await-children)
  getStateRevision(): number;
  waitForStateChange(
    revision: number,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<boolean>;

  // Policy installation
  setPolicy(policy: InvokePolicy | null): void;
  addPolicyRule(rule: InvokePolicy): void;

  // Dangerous-affordance registry consulted by safety rules
  isDangerousAffordance(providerId: string, path: string, action: string): boolean;
}
