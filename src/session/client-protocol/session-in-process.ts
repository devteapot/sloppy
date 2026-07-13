import type { SessionRuntime } from "../runtime";
import type { ApprovalMode } from "../types";
import type {
  ProviderInvokeInput,
  ProviderQueryInput,
  SaveLlmProfileInput,
  SessionClientApi,
  SessionClientSnapshot,
} from "./types";

export class InProcessSessionApi implements SessionClientApi {
  private snapshot: SessionClientSnapshot | null = null;
  private unsubscribe: (() => void) | null = null;
  private connectPromise: Promise<SessionClientSnapshot> | null = null;
  private connectGeneration = 0;
  private generation = 0;
  private readonly listeners = new Set<(snapshot: SessionClientSnapshot) => void>();
  private readonly clientId = `in-process-${crypto.randomUUID()}`;

  constructor(private readonly runtime: SessionRuntime) {}

  connect(): Promise<SessionClientSnapshot> {
    if (this.unsubscribe) {
      return Promise.resolve(this.snapshot ?? this.runtime.getClientSnapshot());
    }
    if (this.connectPromise) {
      if (this.connectGeneration === this.generation) return this.connectPromise;
      return this.connectPromise.then(
        () => this.connect(),
        () => this.connect(),
      );
    }
    const generation = this.generation;
    this.connectGeneration = generation;
    const connecting = this.connectInternal(generation).finally(() => {
      if (this.connectPromise === connecting) this.connectPromise = null;
    });
    this.connectPromise = connecting;
    return connecting;
  }

  disconnect(): void {
    this.generation += 1;
    const wasConnected = this.unsubscribe !== null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (wasConnected) this.runtime.store.unregisterClient(this.clientId);
  }

  getSnapshot(): SessionClientSnapshot | null {
    return this.snapshot;
  }

  onSnapshot(listener: (snapshot: SessionClientSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDisconnect(_listener: (error?: Error) => void): () => void {
    return () => {};
  }

  sendMessage(text: string): Promise<unknown> {
    return this.runtime.sendMessage(text);
  }

  waitForIdle(): Promise<void> {
    return this.runtime.waitForIdle();
  }

  cancelTurn(): Promise<unknown> {
    return this.runtime.cancelTurn();
  }

  cancelQueuedMessage(queuedMessageId: string): Promise<unknown> {
    return Promise.resolve(this.runtime.cancelQueuedMessage(queuedMessageId));
  }

  setApprovalMode(mode: ApprovalMode): Promise<unknown> {
    return Promise.resolve(this.runtime.setApprovalMode(mode));
  }

  approveApproval(approvalId: string): Promise<unknown> {
    return this.runtime.approveApproval(approvalId);
  }

  rejectApproval(approvalId: string, reason?: string): Promise<unknown> {
    return this.runtime.rejectApproval(approvalId, reason);
  }

  cancelTask(taskId: string): Promise<unknown> {
    return this.runtime.cancelTask(taskId);
  }

  saveLlmProfile(input: SaveLlmProfileInput): Promise<unknown> {
    return this.runtime.saveLlmProfile({
      ...(input.profileId && { profile_id: input.profileId }),
      ...(input.label && { label: input.label }),
      ...(input.kind && { kind: input.kind }),
      ...(input.endpointId && { endpoint_id: input.endpointId }),
      ...(input.model && { model: input.model }),
      ...(input.reasoningEffort && { reasoning_effort: input.reasoningEffort }),
      ...(input.thinkingEnabled !== undefined && { thinking_enabled: input.thinkingEnabled }),
      ...(input.thinkingDisplay && { thinking_display: input.thinkingDisplay }),
      ...(input.adapterId && { adapter_id: input.adapterId }),
      ...(input.apiKey && { api_key: input.apiKey }),
      ...(input.makeDefault !== undefined && { make_default: input.makeDefault }),
    });
  }

  setDefaultLlmProfile(profileId: string): Promise<unknown> {
    return this.runtime.setDefaultLlmProfile(profileId);
  }

  deleteLlmProfile(profileId: string): Promise<unknown> {
    return this.runtime.deleteLlmProfile(profileId);
  }

  deleteLlmApiKey(profileId: string): Promise<unknown> {
    return this.runtime.deleteLlmApiKey(profileId);
  }

  reloadConfig(): Promise<unknown> {
    return this.runtime.reloadConfig();
  }

  invokePlugin(
    pluginId: string,
    command: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.runtime.invokePluginClientCommand(pluginId, command, params);
  }

  queryProvider(input: ProviderQueryInput) {
    return this.runtime.queryProviderState(input.providerId, input.path, input);
  }

  invokeProvider(input: ProviderInvokeInput) {
    return this.runtime.invokeProviderAction(
      input.providerId,
      input.path,
      input.action,
      input.params,
    );
  }

  loadProvider(providerId: string): Promise<unknown> {
    return this.runtime.loadProvider(providerId);
  }

  unloadProvider(providerId: string): Promise<unknown> {
    return this.runtime.unloadProvider(providerId);
  }

  reloadProvider(providerId: string): Promise<unknown> {
    return this.runtime.reloadProvider(providerId);
  }

  private publish(): SessionClientSnapshot {
    const snapshot = this.runtime.getClientSnapshot();
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn(
          `[sloppy] in-process session snapshot listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return snapshot;
  }

  private async connectInternal(generation: number): Promise<SessionClientSnapshot> {
    await this.runtime.start();
    if (generation !== this.generation) {
      throw new Error("In-process session connection was cancelled.");
    }
    this.runtime.store.registerClient(this.clientId);
    try {
      this.unsubscribe = this.runtime.store.onChange(() => this.publish());
      return this.publish();
    } catch (error) {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.runtime.store.unregisterClient(this.clientId);
      throw error;
    }
  }
}
