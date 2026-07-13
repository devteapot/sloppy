import type { ResultMessage, SlopNode } from "@slop-ai/consumer/browser";

import type { ApprovalMode } from "../types";
import { RpcSnapshotClient } from "./rpc-client";
import {
  type ProviderInvokeInput,
  type ProviderQueryInput,
  type SaveLlmProfileInput,
  SESSION_CLIENT_PROTOCOL,
  type SessionClientApi,
  type SessionClientSnapshot,
} from "./types";

export class SessionApiClient implements SessionClientApi {
  private readonly rpc: RpcSnapshotClient<SessionClientSnapshot>;

  constructor(endpoint: string) {
    this.rpc = new RpcSnapshotClient(endpoint, SESSION_CLIENT_PROTOCOL);
  }

  connect(timeoutMs?: number): Promise<SessionClientSnapshot> {
    return this.rpc.connect(timeoutMs);
  }

  disconnect(): void {
    this.rpc.disconnect();
  }

  setEndpoint(endpoint: string): void {
    this.rpc.setEndpoint(endpoint);
  }

  getSnapshot(): SessionClientSnapshot | null {
    return this.rpc.getSnapshot();
  }

  onSnapshot(listener: (snapshot: SessionClientSnapshot) => void): () => void {
    return this.rpc.onSnapshot(listener);
  }

  onDisconnect(listener: (error?: Error) => void): () => void {
    return this.rpc.onDisconnect(listener);
  }

  sendMessage(text: string): Promise<unknown> {
    return this.rpc.request("session.sendMessage", { text });
  }

  cancelTurn(): Promise<unknown> {
    return this.rpc.request("turn.cancel");
  }

  cancelQueuedMessage(queuedMessageId: string): Promise<unknown> {
    return this.rpc.request("queue.cancel", { queuedMessageId });
  }

  setApprovalMode(mode: ApprovalMode): Promise<unknown> {
    return this.rpc.request("approval.setMode", { mode });
  }

  approveApproval(approvalId: string): Promise<unknown> {
    return this.rpc.request("approval.approve", { approvalId });
  }

  rejectApproval(approvalId: string, reason?: string): Promise<unknown> {
    return this.rpc.request("approval.reject", { approvalId, ...(reason && { reason }) });
  }

  cancelTask(taskId: string): Promise<unknown> {
    return this.rpc.request("task.cancel", { taskId });
  }

  saveLlmProfile(input: SaveLlmProfileInput): Promise<unknown> {
    return this.rpc.request("llm.saveProfile", { input });
  }

  setDefaultLlmProfile(profileId: string): Promise<unknown> {
    return this.rpc.request("llm.setDefaultProfile", { profileId });
  }

  deleteLlmProfile(profileId: string): Promise<unknown> {
    return this.rpc.request("llm.deleteProfile", { profileId });
  }

  deleteLlmApiKey(profileId: string): Promise<unknown> {
    return this.rpc.request("llm.deleteApiKey", { profileId });
  }

  reloadConfig(): Promise<unknown> {
    return this.rpc.request("config.reload");
  }

  invokePlugin(
    pluginId: string,
    command: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.rpc.request("plugin.invoke", { pluginId, command, ...(params && { params }) });
  }

  queryProvider(input: ProviderQueryInput): Promise<SlopNode> {
    return this.rpc.request("provider.query", input as unknown as Record<string, unknown>);
  }

  invokeProvider(input: ProviderInvokeInput): Promise<ResultMessage> {
    return this.rpc.request("provider.invoke", input as unknown as Record<string, unknown>);
  }

  loadProvider(providerId: string): Promise<unknown> {
    return this.rpc.request("provider.load", { providerId });
  }

  unloadProvider(providerId: string): Promise<unknown> {
    return this.rpc.request("provider.unload", { providerId });
  }

  reloadProvider(providerId: string): Promise<unknown> {
    return this.rpc.request("provider.reload", { providerId });
  }
}
