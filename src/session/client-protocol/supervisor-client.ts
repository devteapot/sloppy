import { RpcSnapshotClient } from "./rpc-client";
import {
  SUPERVISOR_CLIENT_PROTOCOL,
  type SupervisorClientApi,
  type SupervisorClientSnapshot,
  type SupervisorCreateSessionInput,
} from "./types";

export class SupervisorApiClient implements SupervisorClientApi {
  private readonly rpc: RpcSnapshotClient<SupervisorClientSnapshot>;

  constructor(endpoint: string) {
    this.rpc = new RpcSnapshotClient(endpoint, SUPERVISOR_CLIENT_PROTOCOL);
  }

  connect(timeoutMs?: number): Promise<SupervisorClientSnapshot> {
    return this.rpc.connect(timeoutMs);
  }

  disconnect(): void {
    this.rpc.disconnect();
  }

  getSnapshot(): SupervisorClientSnapshot | null {
    return this.rpc.getSnapshot();
  }

  onSnapshot(listener: (snapshot: SupervisorClientSnapshot) => void): () => void {
    return this.rpc.onSnapshot(listener);
  }

  onDisconnect(listener: (error?: Error) => void): () => void {
    return this.rpc.onDisconnect(listener);
  }

  refreshSnapshot(): Promise<SupervisorClientSnapshot> {
    return this.rpc.request("supervisor.snapshot");
  }

  registerLease(selectedSessionId?: string, label?: string): Promise<unknown> {
    return this.rpc.request("lease.register", { selectedSessionId, label });
  }

  updateLease(selectedSessionId?: string, label?: string): Promise<unknown> {
    return this.rpc.request("lease.update", { selectedSessionId, label });
  }

  unregisterLease(): Promise<unknown> {
    return this.rpc.request("lease.unregister");
  }

  createSession(input: SupervisorCreateSessionInput = {}): Promise<ReturnTypeResult> {
    return this.rpc.request("session.create", input as Record<string, unknown>);
  }

  selectSession(sessionId: string): Promise<ReturnTypeResult> {
    return this.rpc.request("session.select", { sessionId });
  }

  stopSession(sessionId: string): Promise<unknown> {
    return this.rpc.request("session.stop", { sessionId });
  }

  reloadConfig(): Promise<unknown> {
    return this.rpc.request("config.reload");
  }

  createScopedSession(
    input: SupervisorCreateSessionInput & { workspaceId: string },
  ): Promise<ReturnTypeResult> {
    return this.rpc.request("scope.createSession", input as Record<string, unknown>);
  }
}

type ReturnTypeResult = import("../supervisor-model").PublicSessionRecord;
