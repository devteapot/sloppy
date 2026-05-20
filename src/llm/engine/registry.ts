import type { EngineLlmProfileConfig } from "../../config/schema";
import type { EngineDescriptor, EngineSyncResult } from "./protocol";

export type EngineRuntimeSession = {
  sessionId: string;
  state: "created" | "synced" | "generating" | "idle" | "closed" | "error";
  position?: number;
  cachedPrefixTokens?: number;
  evaluatedTokens?: number;
  updatedAt: string;
};

export type EngineRuntimeSnapshot = {
  profileId: string;
  label?: string;
  engine: string;
  model: string;
  dialect: string;
  transport: EngineLlmProfileConfig["transport"];
  status: "configured" | "connecting" | "ready" | "generating" | "closed" | "error";
  descriptor?: EngineDescriptor;
  lastError?: string;
  updatedAt: string;
  sessions: EngineRuntimeSession[];
};

export type EngineRuntimeController = {
  refresh(): Promise<void>;
  reconnect(): Promise<void>;
  closeSession(sessionId?: string): Promise<void>;
};

class EngineRuntimeRegistry {
  private snapshots = new Map<string, EngineRuntimeSnapshot>();
  private controllers = new Map<string, EngineRuntimeController>();
  private listeners = new Set<() => void>();

  configureProfiles(profiles: EngineLlmProfileConfig[]): void {
    for (const profile of profiles) {
      const current = this.snapshots.get(profile.id);
      this.snapshots.set(profile.id, {
        profileId: profile.id,
        label: profile.label,
        engine: profile.engine,
        model: profile.model,
        dialect: profile.dialect,
        transport: profile.transport,
        status: current?.status ?? "configured",
        descriptor: current?.descriptor,
        lastError: current?.lastError,
        updatedAt: current?.updatedAt ?? new Date().toISOString(),
        sessions: current?.sessions ?? [],
      });
    }
    this.emit();
  }

  replaceConfiguredProfiles(profiles: EngineLlmProfileConfig[]): void {
    const nextIds = new Set(profiles.map((profile) => profile.id));
    for (const id of [...this.snapshots.keys()]) {
      if (!nextIds.has(id)) {
        this.snapshots.delete(id);
        this.controllers.delete(id);
      }
    }
    this.configureProfiles(profiles);
  }

  registerController(profileId: string, controller: EngineRuntimeController): () => void {
    this.controllers.set(profileId, controller);
    return () => {
      if (this.controllers.get(profileId) === controller) {
        this.controllers.delete(profileId);
      }
    };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  list(): EngineRuntimeSnapshot[] {
    return [...this.snapshots.values()].sort((left, right) =>
      left.profileId.localeCompare(right.profileId),
    );
  }

  setStatus(
    profile: EngineLlmProfileConfig,
    status: EngineRuntimeSnapshot["status"],
    options?: {
      descriptor?: EngineDescriptor;
      lastError?: string;
    },
  ): void {
    const current = this.ensure(profile);
    this.snapshots.set(profile.id, {
      ...current,
      status,
      descriptor: options?.descriptor ?? current.descriptor,
      lastError: options?.lastError,
      updatedAt: new Date().toISOString(),
    });
    this.emit();
  }

  updateSession(
    profile: EngineLlmProfileConfig,
    sessionId: string,
    state: EngineRuntimeSession["state"],
    sync?: EngineSyncResult,
  ): void {
    const current = this.ensure(profile);
    const existing = current.sessions.find((session) => session.sessionId === sessionId);
    const nextSession: EngineRuntimeSession = {
      sessionId,
      state,
      position: sync?.position ?? existing?.position,
      cachedPrefixTokens: sync?.cachedPrefixTokens ?? existing?.cachedPrefixTokens,
      evaluatedTokens: sync?.evaluatedTokens ?? existing?.evaluatedTokens,
      updatedAt: new Date().toISOString(),
    };
    this.snapshots.set(profile.id, {
      ...current,
      status: state === "generating" ? "generating" : current.status,
      sessions: [
        nextSession,
        ...current.sessions.filter((session) => session.sessionId !== sessionId),
      ].slice(0, 20),
      updatedAt: new Date().toISOString(),
    });
    this.emit();
  }

  async refresh(profileId: string): Promise<void> {
    const controller = this.controllers.get(profileId);
    if (!controller) {
      throw new Error(`Engine profile '${profileId}' has no active backend connection.`);
    }
    await controller.refresh();
  }

  async reconnect(profileId: string): Promise<void> {
    const controller = this.controllers.get(profileId);
    if (!controller) {
      throw new Error(`Engine profile '${profileId}' has no active backend connection.`);
    }
    await controller.reconnect();
  }

  async closeSession(profileId: string, sessionId?: string): Promise<void> {
    const controller = this.controllers.get(profileId);
    if (!controller) {
      throw new Error(`Engine profile '${profileId}' has no active backend connection.`);
    }
    await controller.closeSession(sessionId);
  }

  private ensure(profile: EngineLlmProfileConfig): EngineRuntimeSnapshot {
    const current = this.snapshots.get(profile.id);
    if (current) {
      return current;
    }

    const snapshot: EngineRuntimeSnapshot = {
      profileId: profile.id,
      label: profile.label,
      engine: profile.engine,
      model: profile.model,
      dialect: profile.dialect,
      transport: profile.transport,
      status: "configured",
      updatedAt: new Date().toISOString(),
      sessions: [],
    };
    this.snapshots.set(profile.id, snapshot);
    return snapshot;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const engineRuntimeRegistry = new EngineRuntimeRegistry();
