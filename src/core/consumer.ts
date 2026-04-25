import {
  formatTree,
  type HelloMessage,
  type ResultMessage,
  SlopConsumer,
  type SlopNode,
} from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../config/schema";
import type { RegisteredProvider } from "../providers/registry";
import { ApprovalQueue } from "./approvals";
import { debug, isDebugEnabled } from "./debug";
import {
  allowAllPolicy,
  CompositePolicy,
  type InvocationMetadata,
  type InvokeContext,
  type InvokePolicy,
  PolicyDeniedError,
} from "./policy";
import type { ProviderTreeView } from "./subscriptions";
import { buildRuntimeToolSet, type RuntimeToolSet } from "./tools";

type ConnectedProvider = RegisteredProvider & {
  consumer: SlopConsumer;
  hello: HelloMessage;
  overviewSubscriptionId: string;
  overviewTree: SlopNode;
  detailSubscriptionId?: string;
  detailPath?: string;
  detailTree?: SlopNode;
  patchListener: (subscriptionId: string) => void;
  disconnectListener: () => void;
  unsubscribeEvent: (() => void) | null;
  watchedSubscriptions: Map<
    string,
    {
      path: string;
      subscriptionId: string;
      tree: SlopNode;
      listeners: Set<(tree: SlopNode | null) => void>;
    }
  >;
};

export type ExternalProviderStatus = "connected" | "disconnected" | "error";

export type ExternalProviderState = {
  id: string;
  name: string;
  transport: string;
  status: ExternalProviderStatus;
  lastError?: string;
};

export type ProviderEvent = {
  providerId: string;
  name: string;
  data: unknown;
};

function compareExternalProviders(
  left: ExternalProviderState,
  right: ExternalProviderState,
): number {
  const nameComparison = left.name.localeCompare(right.name);
  if (nameComparison !== 0) {
    return nameComparison;
  }

  return left.id.localeCompare(right.id);
}

export class ConsumerHub {
  private providers = new Map<string, ConnectedProvider>();
  private externalProviderStates = new Map<string, ExternalProviderState>();
  private config: SloppyConfig;
  private registeredProviders: RegisteredProvider[];
  private providerEventListeners = new Set<(event: ProviderEvent) => void>();
  private externalProviderStateListeners = new Set<(states: ExternalProviderState[]) => void>();
  private stateRevision = 0;
  private stateRevisionListeners = new Set<() => void>();
  private policy: InvokePolicy = allowAllPolicy;
  private policyRules: CompositePolicy | null = null;
  /**
   * Hub-owned approval queue. Single source of truth for any policy-mediated
   * `require_approval` decision; per-provider `/approvals` SLOP collections
   * are filtered views over this queue once their `ProviderApprovalManager`
   * is attached via the registry.
   */
  readonly approvals = new ApprovalQueue();

  constructor(registeredProviders: RegisteredProvider[], config: SloppyConfig) {
    this.registeredProviders = registeredProviders;
    this.config = config;
  }

  /**
   * Replace the hub-level invoke policy. The hub uses an `allow-all` policy
   * by default so existing call sites and tests are unaffected. Application
   * code can install a `CompositePolicy` to layer rules.
   */
  setPolicy(policy: InvokePolicy | null): void {
    this.policy = policy ?? allowAllPolicy;
    this.policyRules = policy instanceof CompositePolicy ? policy : null;
  }

  /**
   * Append a rule to the hub-level composite policy, lazily constructing one
   * if a non-composite (or default) policy is currently installed. Used by
   * extensions (e.g. orchestration) to register role-scoped policies in
   * `attachRuntime` without replacing whatever else is installed.
   */
  addPolicyRule(rule: InvokePolicy): void {
    if (!this.policyRules) {
      const composite = new CompositePolicy();
      // If a non-default policy was set, preserve it as the first rule so we
      // keep its semantics intact.
      if (this.policy !== allowAllPolicy) {
        composite.add(this.policy);
      }
      this.policy = composite;
      this.policyRules = composite;
    }
    this.policyRules.add(rule);
  }

  /**
   * @deprecated No-op shim. Role/actor metadata is now scoped per-invocation —
   * pass `{ roleId, actor }` as the final argument to `hub.invoke(...)`. This
   * method is retained only so legacy call sites compile while migrating; it
   * intentionally does nothing because hub-wide metadata leaked across
   * invocations (see policy-isolation.test.ts for the regression).
   */
  setInvocationMetadata(_metadata: { roleId?: string }): void {
    // intentionally empty — see deprecation note above.
  }

  async connect(): Promise<void> {
    for (const registeredProvider of this.registeredProviders) {
      await this.addProvider(registeredProvider);
    }
  }

  async addProvider(registeredProvider: RegisteredProvider): Promise<boolean> {
    if (this.providers.has(registeredProvider.id)) {
      return true;
    }

    try {
      const consumer = new SlopConsumer(registeredProvider.transport);
      const hello = await consumer.connect();
      const overview = await consumer.subscribe("/", this.config.agent.overviewDepth, {
        max_nodes: this.config.agent.overviewMaxNodes,
        filter: { min_salience: this.config.agent.minSalience },
      });

      const patchListener = (subscriptionId: string) => {
        const tree = consumer.getTree(subscriptionId);
        if (!tree) {
          return;
        }

        const connectedProvider = this.providers.get(registeredProvider.id);
        if (!connectedProvider) {
          return;
        }

        if (subscriptionId === connectedProvider.overviewSubscriptionId) {
          connectedProvider.overviewTree = tree;
          this.bumpStateRevision();
          return;
        }

        if (subscriptionId === connectedProvider.detailSubscriptionId) {
          connectedProvider.detailTree = tree;
          this.bumpStateRevision();
          return;
        }

        for (const watched of connectedProvider.watchedSubscriptions.values()) {
          if (subscriptionId !== watched.subscriptionId) {
            continue;
          }

          watched.tree = tree;
          for (const listener of watched.listeners) {
            listener(tree);
          }
          this.bumpStateRevision();
          return;
        }
      };
      const disconnectListener = () => {
        this.teardownProvider(registeredProvider.id, {
          connectionAlive: false,
          disconnectError: "Provider disconnected.",
        });
      };
      const unsubscribeEvent = consumer.onEvent((name, data) => {
        for (const listener of this.providerEventListeners) {
          listener({
            providerId: registeredProvider.id,
            name,
            data,
          });
        }
      });

      const provider: ConnectedProvider = {
        ...registeredProvider,
        consumer,
        hello,
        overviewSubscriptionId: overview.id,
        overviewTree: overview.snapshot,
        patchListener,
        disconnectListener,
        unsubscribeEvent,
        watchedSubscriptions: new Map(),
      };

      consumer.on("patch", patchListener);
      consumer.on("disconnect", disconnectListener);

      this.providers.set(provider.id, provider);
      // Connect any per-provider approval manager to the hub-owned queue so
      // its `/approvals` collection becomes a filtered view of the shared
      // queue and any policy-mediated approval requests show up there too.
      provider.approvals?.setQueue(this.approvals);
      if (provider.kind === "external") {
        this.upsertExternalProviderState({
          id: provider.id,
          name: provider.name,
          transport: provider.transportLabel,
          status: "connected",
        });
      }
      debug("hub", "add_provider", { id: provider.id, kind: provider.kind });
      this.bumpStateRevision();
      return true;
    } catch (error) {
      registeredProvider.stop?.();
      if (registeredProvider.kind === "external") {
        this.upsertExternalProviderState({
          id: registeredProvider.id,
          name: registeredProvider.name,
          transport: registeredProvider.transportLabel,
          status: "error",
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      debug("hub", "add_provider_error", { id: registeredProvider.id, error: message });
      if (!isDebugEnabled("hub")) {
        console.warn(`[sloppy] skipped provider ${registeredProvider.id}: ${message}`);
      }
      return false;
    }
  }

  removeProvider(providerId: string): void {
    debug("hub", "remove_provider", { id: providerId });
    this.teardownProvider(providerId, { connectionAlive: true, removeExternalState: true });
  }

  private teardownProvider(
    providerId: string,
    options: {
      connectionAlive: boolean;
      removeExternalState?: boolean;
      disconnectError?: string;
    },
  ): void {
    const provider = this.providers.get(providerId);
    if (!provider) {
      if (options.removeExternalState) {
        this.deleteExternalProviderState(providerId);
      }
      return;
    }

    provider.consumer.off("patch", provider.patchListener);
    provider.consumer.off("disconnect", provider.disconnectListener);
    provider.unsubscribeEvent?.();
    provider.unsubscribeEvent = null;

    for (const watched of provider.watchedSubscriptions.values()) {
      try {
        provider.consumer.unsubscribe(watched.subscriptionId);
      } catch {
        // The provider may have already disconnected before watched subscriptions could be removed.
      }
    }
    provider.watchedSubscriptions.clear();

    if (options.connectionAlive && provider.detailSubscriptionId) {
      try {
        provider.consumer.unsubscribe(provider.detailSubscriptionId);
      } catch {
        // The provider may have dropped between the decision to remove it and the unsubscribe call.
      }
    }

    if (options.connectionAlive) {
      try {
        provider.consumer.unsubscribe(provider.overviewSubscriptionId);
      } catch {
        // The provider may have dropped before we could unsubscribe the overview subscription.
      }

      try {
        provider.consumer.disconnect();
      } catch {
        // Best-effort disconnect after unsubscribe failures.
      }
    }

    provider.approvals?.setQueue(null);
    provider.stop?.();
    this.providers.delete(providerId);
    this.bumpStateRevision();
    if (provider.kind === "external") {
      if (options.removeExternalState) {
        this.deleteExternalProviderState(providerId);
      } else {
        this.upsertExternalProviderState({
          id: provider.id,
          name: provider.name,
          transport: provider.transportLabel,
          status: "disconnected",
          lastError: options.disconnectError ?? "Provider disconnected.",
        });
      }
    }
  }

  getProviderViews(): ProviderTreeView[] {
    return [...this.providers.values()].map((provider) => ({
      providerId: provider.id,
      providerName: provider.name,
      kind: provider.kind,
      overviewTree: provider.overviewTree,
      detailPath: provider.detailPath,
      detailTree: provider.detailTree,
    }));
  }

  getRuntimeToolSet(): RuntimeToolSet {
    return buildRuntimeToolSet(this.getProviderViews());
  }

  getStateRevision(): number {
    return this.stateRevision;
  }

  async waitForStateChange(
    revision: number,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<boolean> {
    if (this.stateRevision !== revision) {
      return true;
    }

    if (options.signal?.aborted) {
      return false;
    }

    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const finish = (changed: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        this.stateRevisionListeners.delete(listener);
        options.signal?.removeEventListener("abort", onAbort);
        resolve(changed);
      };

      const listener = () => {
        if (this.stateRevision !== revision) {
          finish(true);
        }
      };
      const onAbort = () => finish(false);

      this.stateRevisionListeners.add(listener);
      options.signal?.addEventListener("abort", onAbort, { once: true });

      if (options.timeoutMs != null) {
        timeout = setTimeout(() => finish(false), options.timeoutMs);
      }
    });
  }

  getExternalProviderStates(): ExternalProviderState[] {
    return [...this.externalProviderStates.values()].sort(compareExternalProviders);
  }

  async queryState(options: {
    providerId: string;
    path: string;
    depth?: number;
    maxNodes?: number;
    minSalience?: number;
    window?: [number, number];
  }): Promise<SlopNode> {
    const provider = this.requireProvider(options.providerId);
    return provider.consumer.query(options.path, options.depth ?? 2, {
      max_nodes: options.maxNodes,
      filter: options.minSalience != null ? { min_salience: options.minSalience } : undefined,
      window: options.window,
    });
  }

  async focusState(options: {
    providerId: string;
    path: string;
    depth?: number;
    maxNodes?: number;
  }): Promise<SlopNode> {
    const provider = this.requireProvider(options.providerId);

    if (provider.detailSubscriptionId) {
      provider.consumer.unsubscribe(provider.detailSubscriptionId);
      provider.detailSubscriptionId = undefined;
      provider.detailPath = undefined;
      provider.detailTree = undefined;
    }

    const detail = await provider.consumer.subscribe(
      options.path,
      options.depth ?? this.config.agent.detailDepth,
      {
        max_nodes: options.maxNodes ?? this.config.agent.detailMaxNodes,
      },
    );
    provider.detailSubscriptionId = detail.id;
    provider.detailPath = options.path;
    provider.detailTree = detail.snapshot;
    return detail.snapshot;
  }

  async invoke(
    providerId: string,
    path: string,
    action: string,
    params?: Record<string, unknown>,
    metadata?: InvocationMetadata,
  ): Promise<ResultMessage> {
    return this.invokeInternal(providerId, path, action, params, metadata, false);
  }

  private async invokeInternal(
    providerId: string,
    path: string,
    action: string,
    params: Record<string, unknown> | undefined,
    metadata: InvocationMetadata | undefined,
    preApproved: boolean,
  ): Promise<ResultMessage> {
    const provider = this.requireProvider(providerId);

    if (this.policy !== allowAllPolicy) {
      const ctx: InvokeContext = {
        providerId,
        action,
        path,
        params: params ?? {},
        roleId: metadata?.roleId,
        preApproved,
        config: this.config,
      };
      const decision = await this.policy.evaluate(ctx);
      if (decision.kind === "deny") {
        throw new PolicyDeniedError(decision.reason);
      }
      if (decision.kind === "require_approval") {
        // Enqueue into the hub-owned approval queue so the user can resolve it
        // via the per-provider `/approvals` collection (or any UI watching
        // `hub.approvals`). On approve, the action is re-invoked with
        // `preApproved: true` (out of band, NOT a `params` field) so the rule
        // short-circuits and the invocation proceeds. Returning the SLOP
        // `approval_required` error preserves the existing run-loop / tooling
        // contract.
        //
        // The original invocation's `metadata` is captured here and replayed
        // on approve so policy rules see the same role/actor on the second
        // pass. Without this, the re-invoke would inherit no metadata (or,
        // pre-fix, a stale hub-wide value).
        const capturedMetadata = metadata;
        const approvalId = this.approvals.enqueue({
          providerId,
          path,
          action,
          reason: decision.reason,
          paramsPreview: decision.paramsPreview,
          dangerous: decision.dangerous,
          execute: () =>
            this.invokeInternal(providerId, path, action, params, capturedMetadata, true),
        });
        return {
          status: "error",
          error: {
            code: "approval_required",
            message: `${decision.reason} Resolve via /approvals/${approvalId} on provider ${providerId}.`,
          },
        } as ResultMessage;
      }
    }

    return provider.consumer.invoke(path, action, params);
  }

  async watchPath(
    providerId: string,
    path: string,
    listener: (tree: SlopNode | null) => void,
    options?: {
      depth?: number;
      maxNodes?: number;
    },
  ): Promise<() => void> {
    const provider = this.requireProvider(providerId);
    const existing = provider.watchedSubscriptions.get(path);
    if (existing) {
      existing.listeners.add(listener);
      listener(existing.tree);
      return () => {
        this.removeWatchListener(provider, path, listener);
      };
    }

    try {
      const subscription = await provider.consumer.subscribe(path, options?.depth ?? 2, {
        max_nodes: options?.maxNodes ?? this.config.agent.detailMaxNodes,
      });
      const watched = {
        path,
        subscriptionId: subscription.id,
        tree: subscription.snapshot,
        listeners: new Set<(tree: SlopNode | null) => void>([listener]),
      };
      provider.watchedSubscriptions.set(path, watched);
      listener(subscription.snapshot);
      return () => {
        this.removeWatchListener(provider, path, listener);
      };
    } catch (error) {
      const candidate = error as { code?: string };
      if (candidate?.code === "not_found") {
        listener(null);
        return () => undefined;
      }
      throw error;
    }
  }

  onProviderEvent(listener: (event: ProviderEvent) => void): () => void {
    this.providerEventListeners.add(listener);
    return () => {
      this.providerEventListeners.delete(listener);
    };
  }

  onExternalProviderStateChange(listener: (states: ExternalProviderState[]) => void): () => void {
    this.externalProviderStateListeners.add(listener);
    return () => {
      this.externalProviderStateListeners.delete(listener);
    };
  }

  shutdown(): void {
    for (const providerId of [...this.providers.keys()]) {
      this.removeProvider(providerId);
    }
  }

  formatSnapshot(tree: SlopNode): string {
    return formatTree(tree);
  }

  private requireProvider(providerId: string): ConnectedProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerId}`);
    }

    return provider;
  }

  private removeWatchListener(
    provider: ConnectedProvider,
    path: string,
    listener: (tree: SlopNode | null) => void,
  ): void {
    const watched = provider.watchedSubscriptions.get(path);
    if (!watched) {
      return;
    }

    watched.listeners.delete(listener);
    if (watched.listeners.size > 0) {
      return;
    }

    provider.watchedSubscriptions.delete(path);
    try {
      provider.consumer.unsubscribe(watched.subscriptionId);
    } catch {
      // Best-effort cleanup when the provider disconnected before unsubscribe.
    }
  }

  private upsertExternalProviderState(state: ExternalProviderState): void {
    this.externalProviderStates.set(state.id, state);
    this.emitExternalProviderStateChange();
  }

  private deleteExternalProviderState(providerId: string): void {
    if (!this.externalProviderStates.delete(providerId)) {
      return;
    }

    this.emitExternalProviderStateChange();
  }

  private emitExternalProviderStateChange(): void {
    const states = this.getExternalProviderStates();
    for (const listener of this.externalProviderStateListeners) {
      listener(states);
    }
  }

  private bumpStateRevision(): void {
    this.stateRevision += 1;
    for (const listener of this.stateRevisionListeners) {
      listener();
    }
  }
}
