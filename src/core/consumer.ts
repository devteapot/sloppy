// `ConsumerHub` is the consumer-side provider boundary. External callers
// (loop, agent, runtime/*) should depend on the `ProviderRuntimeHub`
// interface (see `src/core/hub.ts` once Step 2 lands), not this concrete
// class. Keeping the interface narrow is what enforces "thin core, fat
// providers".

import {
  type HelloMessage,
  type ResultMessage,
  SlopConsumer,
  type SlopNode,
} from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../config/schema";
import type { RegisteredProvider } from "../providers/registry";
import { ApprovalQueue } from "./approvals";
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
import type { ProviderTreeView } from "./subscriptions";
import { buildRuntimeToolSet, type RuntimeToolSet } from "./tools";
import { formatStateTree } from "./tree-format";

type ConnectedProvider = RegisteredProvider & {
  consumer: SlopConsumer;
  hello: HelloMessage;
  overviewSubscriptionId: string;
  overviewTree: SlopNode;
  focusSubscriptions: Map<
    string,
    {
      path: string;
      subscriptionId: string;
      tree: SlopNode;
      depth: number;
    }
  >;
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

const AFFORDANCE_KEY_SEPARATOR = "\u001f";

function buildAffordanceKey(providerId: string, path: string, action: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return [providerId, normalizedPath, action].join(AFFORDANCE_KEY_SEPARATOR);
}

function joinPath(parent: string, segment: string): string {
  if (parent === "/" || parent === "") {
    return `/${segment}`;
  }
  return `${parent}/${segment}`;
}

function walkAffordances(
  node: SlopNode,
  path: string,
  visit: (path: string, action: string, dangerous: boolean) => void,
): void {
  if (Array.isArray(node.affordances)) {
    for (const aff of node.affordances) {
      visit(path, aff.action, aff.dangerous === true);
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      if (typeof child.id !== "string" || child.id.length === 0) {
        continue;
      }
      walkAffordances(child, joinPath(path, child.id), visit);
    }
  }
}

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
   * Populated by walking each provider's subscribed trees whenever they
   * update; entries are sticky (never removed) so an affordance discovered
   * in a focused/detail tree continues to be policed even after the focus
   * moves elsewhere. `dangerousActionRule` consults this registry so it
   * does not depend on an affordance being present in a *currently* visible
   * subtree at the moment of invocation.
   */
  private dangerousAffordances = new Set<string>();

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
      const consumer = new SlopConsumer(registeredProvider.transport);
      const hello = await consumer.connect();
      const overview = await consumer.subscribe("/", this.config.agent.overviewDepth);

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
          this.recordDangerousAffordances(connectedProvider.id, tree);
          this.bumpStateRevision();
          return;
        }

        for (const focus of connectedProvider.focusSubscriptions.values()) {
          if (subscriptionId !== focus.subscriptionId) {
            continue;
          }
          focus.tree = tree;
          this.recordDangerousAffordances(connectedProvider.id, tree, focus.path);
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
        focusSubscriptions: new Map(),
        patchListener,
        disconnectListener,
        unsubscribeEvent,
        watchedSubscriptions: new Map(),
      };

      consumer.on("patch", patchListener);
      consumer.on("disconnect", disconnectListener);

      this.providers.set(provider.id, provider);
      this.recordDangerousAffordances(provider.id, provider.overviewTree);
      // One-shot deep, unfiltered query so the dangerous-affordance registry
      // also covers nodes that the depth-bounded overview
      // subscription doesn't surface. Best-effort: a failure here must not
      // break provider attach (the per-subscription walk above remains the
      // baseline). Nodes added at runtime under subscribed subtrees are
      // picked up by the patch listener.
      try {
        const deep = await consumer.query("/", DANGEROUS_DISCOVERY_DEPTH, {
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
    this.registeredProviderById.delete(providerId);
  }

  async retryProvider(providerId: string): Promise<boolean> {
    if (this.providers.has(providerId)) {
      return true;
    }
    const registeredProvider = this.registeredProviderById.get(providerId);
    if (!registeredProvider) {
      throw new Error(`Unknown registered provider: ${providerId}`);
    }
    return this.addProvider(registeredProvider);
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

    for (const focus of provider.focusSubscriptions.values()) {
      try {
        provider.consumer.unsubscribe(focus.subscriptionId);
      } catch {
        // The provider may have dropped between the decision to remove it and the unsubscribe call.
      }
    }
    provider.focusSubscriptions.clear();

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
    return this.dangerousAffordances.has(buildAffordanceKey(providerId, path, action));
  }

  private recordDangerousAffordances(
    providerId: string,
    tree: SlopNode,
    rootPath: string = "/",
  ): boolean {
    let added = false;
    walkAffordances(tree, rootPath, (path, action, dangerous) => {
      if (dangerous) {
        const before = this.dangerousAffordances.size;
        this.dangerousAffordances.add(buildAffordanceKey(providerId, path, action));
        if (this.dangerousAffordances.size > before) {
          added = true;
        }
      }
    });
    return added;
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

  private bumpStateRevision(): void {
    this.stateRevision += 1;
    for (const listener of this.stateRevisionListeners) {
      listener();
    }
  }
}
