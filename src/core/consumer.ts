// `ConsumerHub` is the consumer-side provider boundary. External callers
// (loop, agent, runtime/*) should depend on the `ProviderRuntimeHub`
// interface (see `src/core/hub.ts` once Step 2 lands), not this concrete
// class. Keeping the interface narrow is what enforces "thin core, fat
// providers".

import type { ResultMessage, SlopNode } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../config/schema";
import type { RegisteredProvider } from "../providers/registry";
import { ApprovalQueue } from "./approvals";
import { DangerousAffordanceIndex } from "./dangerous-affordance-index";
import { debug, isDebugEnabled } from "./debug";
import type { ProviderRuntimeHub } from "./hub";
import {
  allowAllPolicy,
  CompositePolicy,
  type InvocationMetadata,
  type InvokeContext,
  type InvokePolicy,
  PolicyDeniedError,
} from "./policy";
import { type ConnectedProvider, connectProvider, disconnectProvider } from "./provider-connection";
import type { ProviderTreeView } from "./subscriptions";
import { buildRuntimeToolSet, type RuntimeToolSet } from "./tools";
import { formatStateTree } from "./tree-format";

export type ExternalProviderStatus = "connected" | "disconnected" | "error" | "unloaded";

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

export type ProviderLifecycleEvent =
  | {
      kind: "connected";
      providerId: string;
    }
  | {
      kind: "detached";
      providerId: string;
      reason: "disconnected" | "removed" | "reload" | "shutdown" | "unloaded";
    };

// Bounds for the one-shot deep query that seeds the dangerous-affordance
// registry on provider attach. High enough to walk realistic provider trees
// in full without being unbounded.
const DANGEROUS_DISCOVERY_DEPTH = 32;
const DANGEROUS_DISCOVERY_MAX_NODES = 10000;

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

export class ConsumerHub implements ProviderRuntimeHub {
  private providers = new Map<string, ConnectedProvider>();
  private externalProviderStates = new Map<string, ExternalProviderState>();
  private registeredProviderById = new Map<string, RegisteredProvider>();
  private config: SloppyConfig;
  private registeredProviders: RegisteredProvider[];
  private providerEventListeners = new Set<(event: ProviderEvent) => void>();
  private providerLifecycleEventListeners = new Set<
    (event: ProviderLifecycleEvent) => void | Promise<void>
  >();
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
  /**
   * Hub-level registry of affordances marked `dangerous: true` in their
   * descriptors. Keyed by provider id, path, and action with a text-safe
   * separator.
   * Populated by walking each connected provider's observed trees whenever
   * they update. Entries are scoped to the current provider attachment and
   * cleared when that provider detaches, so unloaded app cards do not keep
   * stale affordance metadata alive.
   */
  private dangerousAffordances = new DangerousAffordanceIndex();

  constructor(registeredProviders: RegisteredProvider[], config: SloppyConfig) {
    this.registeredProviders = registeredProviders;
    this.registeredProviderById = new Map(
      registeredProviders.map((provider) => [provider.id, provider]),
    );
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

  async connect(): Promise<void> {
    for (const registeredProvider of this.registeredProviders) {
      await this.addProvider(registeredProvider);
    }
  }

  async addProvider(registeredProvider: RegisteredProvider): Promise<boolean> {
    this.registeredProviderById.set(registeredProvider.id, registeredProvider);
    if (this.providers.has(registeredProvider.id)) {
      return true;
    }

    try {
      const provider = await connectProvider(registeredProvider, this.config.agent.overviewDepth, {
        onPatch: (providerId, subscriptionId, tree) =>
          this.handleProviderPatch(providerId, subscriptionId, tree),
        onDisconnect: (providerId) => {
          this.teardownProvider(providerId, {
            connectionAlive: false,
            disconnectError: "Provider disconnected.",
            lifecycleReason: "disconnected",
          });
        },
        onEvent: (providerId, name, data) => {
          for (const listener of this.providerEventListeners) {
            listener({ providerId, name, data });
          }
        },
      });

      this.providers.set(provider.id, provider);
      this.recordDangerousAffordances(provider.id, provider.overviewTree);
      // One-shot deep, unfiltered query so the dangerous-affordance registry
      // also covers nodes that the depth-bounded overview
      // subscription doesn't surface. Best-effort: a failure here must not
      // break provider attach (the per-subscription walk above remains the
      // baseline). Nodes added at runtime under subscribed subtrees are
      // picked up by the patch listener.
      try {
        const deep = await provider.consumer.query("/", DANGEROUS_DISCOVERY_DEPTH, {
          max_nodes: DANGEROUS_DISCOVERY_MAX_NODES,
        });
        this.recordDangerousAffordances(provider.id, deep);
      } catch (error) {
        debug("hub", "dangerous_discovery_failed", {
          providerId: provider.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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
      await this.emitProviderLifecycleEvent({
        kind: "connected",
        providerId: provider.id,
      });
      return true;
    } catch (error) {
      if (registeredProvider.kind !== "external") {
        registeredProvider.stop?.();
      }
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

  registerProvider(registeredProvider: RegisteredProvider): void {
    this.registeredProviderById.set(registeredProvider.id, registeredProvider);
    if (registeredProvider.kind === "external" && !this.providers.has(registeredProvider.id)) {
      this.upsertExternalProviderState({
        id: registeredProvider.id,
        name: registeredProvider.name,
        transport: registeredProvider.transportLabel,
        status: "unloaded",
      });
    }
  }

  removeProvider(providerId: string): void {
    debug("hub", "remove_provider", { id: providerId });
    const registeredProvider = this.registeredProviderById.get(providerId);
    this.teardownProvider(providerId, {
      connectionAlive: true,
      removeExternalState: true,
      lifecycleReason: "removed",
      stopProvider: registeredProvider?.kind === "external" ? false : undefined,
    });
    this.registeredProviderById.delete(providerId);
  }

  unloadProvider(providerId: string): boolean {
    const registeredProvider = this.registeredProviderById.get(providerId);
    if (!registeredProvider) {
      throw new Error(`Unknown registered provider: ${providerId}`);
    }
    if (registeredProvider.kind !== "external") {
      throw new Error(`Provider is not an unloadable app: ${providerId}`);
    }

    if (!this.providers.has(providerId)) {
      this.clearDangerousAffordances(providerId);
      this.upsertExternalProviderState({
        id: registeredProvider.id,
        name: registeredProvider.name,
        transport: registeredProvider.transportLabel,
        status: "unloaded",
      });
      return false;
    }

    debug("hub", "unload_provider", { id: providerId });
    this.teardownProvider(providerId, {
      connectionAlive: true,
      externalStatus: "unloaded",
      lifecycleReason: "unloaded",
      stopProvider: false,
    });
    return true;
  }

  async loadProvider(providerId: string): Promise<boolean> {
    if (this.providers.has(providerId)) {
      return true;
    }
    const registeredProvider = this.registeredProviderById.get(providerId);
    if (!registeredProvider) {
      throw new Error(`Unknown registered provider: ${providerId}`);
    }
    if (registeredProvider.kind !== "external") {
      throw new Error(`Provider is not a loadable app: ${providerId}`);
    }
    const connected = await this.addProvider(registeredProvider);
    if (!connected) {
      throw new Error(`Failed to load provider: ${providerId}`);
    }
    return false;
  }

  async reloadProvider(providerId: string): Promise<void> {
    const registeredProvider = this.registeredProviderById.get(providerId);
    if (!registeredProvider) {
      throw new Error(`Unknown registered provider: ${providerId}`);
    }
    if (registeredProvider.kind !== "external") {
      throw new Error(`Provider is not a reloadable app: ${providerId}`);
    }
    if (!this.providers.has(providerId)) {
      throw new Error(`Cannot reload provider that is not connected: ${providerId}`);
    }

    debug("hub", "reload_provider", { id: providerId });
    this.teardownProvider(providerId, {
      connectionAlive: true,
      lifecycleReason: "reload",
      stopProvider: false,
      suppressExternalState: true,
    });
    const connected = await this.addProvider(registeredProvider);
    if (!connected) {
      throw new Error(`Failed to reload provider: ${providerId}`);
    }
  }

  private handleProviderPatch(providerId: string, subscriptionId: string, tree: SlopNode): void {
    const provider = this.providers.get(providerId);
    if (!provider) return;

    if (subscriptionId === provider.overviewSubscriptionId) {
      provider.overviewTree = tree;
      this.recordDangerousAffordances(provider.id, tree);
      this.bumpStateRevision();
      return;
    }

    for (const focus of provider.focusSubscriptions.values()) {
      if (subscriptionId !== focus.subscriptionId) continue;
      focus.tree = tree;
      this.recordDangerousAffordances(provider.id, tree, focus.path);
      this.bumpStateRevision();
      return;
    }

    for (const watched of provider.watchedSubscriptions.values()) {
      if (subscriptionId !== watched.subscriptionId) continue;
      watched.tree = tree;
      for (const listener of watched.listeners) {
        listener(tree);
      }
      this.bumpStateRevision();
      return;
    }
  }

  private teardownProvider(
    providerId: string,
    options: {
      connectionAlive: boolean;
      removeExternalState?: boolean;
      disconnectError?: string;
      externalStatus?: Exclude<ExternalProviderStatus, "connected" | "error">;
      lifecycleReason: Extract<ProviderLifecycleEvent, { kind: "detached" }>["reason"];
      stopProvider?: boolean;
      suppressExternalState?: boolean;
    },
  ): void {
    const provider = this.providers.get(providerId);
    if (!provider) {
      this.clearDangerousAffordances(providerId);
      if (options.removeExternalState) {
        this.deleteExternalProviderState(providerId);
      }
      return;
    }

    disconnectProvider(provider, options.connectionAlive);

    provider.approvals?.setQueue(null);
    if (options.stopProvider !== false) {
      provider.stop?.();
    }
    this.providers.delete(providerId);
    this.clearDangerousAffordances(providerId);
    this.bumpStateRevision();
    if (provider.kind === "external") {
      if (options.removeExternalState) {
        this.deleteExternalProviderState(providerId);
      } else if (!options.suppressExternalState) {
        const status = options.externalStatus ?? "disconnected";
        this.upsertExternalProviderState({
          id: provider.id,
          name: provider.name,
          transport: provider.transportLabel,
          status,
          ...(status === "unloaded"
            ? {}
            : { lastError: options.disconnectError ?? "Provider disconnected." }),
        });
      }
    }
    void this.emitProviderLifecycleEvent({
      kind: "detached",
      providerId,
      reason: options.lifecycleReason,
    });
  }

  /**
   * Reports whether the affordance at `(providerId, path, action)` was ever
   * observed with `dangerous: true` in any of this provider's subscribed
   * trees. Entries are sticky, so once seen the affordance stays marked
   * even if a later subscription update no longer includes the node (e.g.
   * the user moved focus away). Misses (affordance never observed) return
   * `false` — `dangerousActionRule` keeps today's open behavior in that
   * case, with the difference that the registry now spans ALL trees the
   * hub has ever seen, not just the currently-focused subtree.
   */
  isDangerousAffordance(providerId: string, path: string, action: string): boolean {
    return this.dangerousAffordances.has(providerId, path, action);
  }

  private recordDangerousAffordances(
    providerId: string,
    tree: SlopNode,
    rootPath: string = "/",
  ): boolean {
    return this.dangerousAffordances.record(providerId, tree, rootPath);
  }

  getProviderViews(): ProviderTreeView[] {
    return [...this.providers.values()].map((provider) => ({
      providerId: provider.id,
      providerName: provider.name,
      kind: provider.kind,
      overviewTree: provider.overviewTree,
      focuses: [...provider.focusSubscriptions.values()]
        .map((focus) => ({
          path: focus.path,
          tree: focus.tree,
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
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
    window?: [number, number];
  }): Promise<SlopNode> {
    const provider = this.requireProvider(options.providerId);
    const tree = await provider.consumer.query(options.path, options.depth ?? 2, {
      max_nodes: options.maxNodes,
      window: options.window,
    });
    if (this.recordDangerousAffordances(provider.id, tree, options.path)) {
      this.bumpStateRevision();
    }
    return tree;
  }

  async focusState(options: {
    providerId: string;
    path: string;
    depth?: number;
  }): Promise<SlopNode> {
    const provider = this.requireProvider(options.providerId);
    const existing = provider.focusSubscriptions.get(options.path);
    if (existing) {
      provider.consumer.unsubscribe(existing.subscriptionId);
      provider.focusSubscriptions.delete(options.path);
    }

    const depth = options.depth ?? this.config.agent.detailDepth;
    const detail = await provider.consumer.subscribe(options.path, depth);
    provider.focusSubscriptions.set(options.path, {
      path: options.path,
      subscriptionId: detail.id,
      tree: detail.snapshot,
      depth,
    });
    // Walk the focus snapshot for dangerous affordances now, the same way the
    // patch listener does on detail-tree updates. Without this, an affordance
    // newly visible in the focused subtree but absent from earlier overview /
    // deep-discovery walks could slip past dangerousActionRule until a later
    // patch surfaced it. Bumping the revision here mirrors patch handling.
    this.recordDangerousAffordances(provider.id, detail.snapshot, options.path);
    this.bumpStateRevision();
    return detail.snapshot;
  }

  async unfocusState(options: { providerId: string; path: string }): Promise<{ removed: boolean }> {
    const provider = this.requireProvider(options.providerId);
    const existing = provider.focusSubscriptions.get(options.path);
    if (!existing) {
      return { removed: false };
    }
    provider.focusSubscriptions.delete(options.path);
    try {
      provider.consumer.unsubscribe(existing.subscriptionId);
    } catch {
      // Best-effort cleanup when the provider disconnected before unsubscribe.
    }
    this.bumpStateRevision();
    return { removed: true };
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
          // Surface the hub-owned approval id in `data` so callers (run loop /
          // session runtime) can match approvals strictly by id rather than
          // by re-parsing the human-readable message or tuple-matching the
          // mirrored `/approvals` tree.
          data: { approvalId, providerId, path, action },
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
        max_nodes: options?.maxNodes,
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

  onProviderLifecycleEvent(
    listener: (event: ProviderLifecycleEvent) => void | Promise<void>,
  ): () => void {
    this.providerLifecycleEventListeners.add(listener);
    return () => {
      this.providerLifecycleEventListeners.delete(listener);
    };
  }

  shutdown(): void {
    for (const providerId of [...this.providers.keys()]) {
      this.teardownProvider(providerId, {
        connectionAlive: true,
        lifecycleReason: "shutdown",
      });
    }
    this.registeredProviderById.clear();
    if (this.externalProviderStates.size > 0) {
      this.externalProviderStates.clear();
      this.emitExternalProviderStateChange();
    }
  }

  formatSnapshot(tree: SlopNode): string {
    return formatStateTree(tree);
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

  private async emitProviderLifecycleEvent(event: ProviderLifecycleEvent): Promise<void> {
    await Promise.all([...this.providerLifecycleEventListeners].map((listener) => listener(event)));
  }

  private clearDangerousAffordances(providerId: string): void {
    this.dangerousAffordances.clearProvider(providerId);
  }

  private bumpStateRevision(): void {
    this.stateRevision += 1;
    for (const listener of this.stateRevisionListeners) {
      listener();
    }
  }
}
