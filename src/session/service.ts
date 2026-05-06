import { listenUnix } from "@slop-ai/server/unix";

import type { SloppyConfig } from "../config/schema";
import type { LlmProfileManager } from "../llm/profile-manager";
import { AgentSessionProvider } from "./provider";
import { SessionRuntime } from "./runtime";
import { closeUnixListener, type UnixListener } from "./socket";

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function defaultSocketPath(providerId: string): string {
  return `/tmp/slop/${sanitizeSegment(providerId)}.sock`;
}

export class SessionService {
  private static sessions = new Map<string, SessionService>();

  readonly runtime: SessionRuntime;
  readonly provider: AgentSessionProvider;
  readonly providerId: string;
  readonly socketPath: string;

  private unixListener: UnixListener | null = null;

  constructor(options?: {
    config?: SloppyConfig;
    sessionId?: string;
    title?: string;
    providerId?: string;
    providerName?: string;
    socketPath?: string;
    llmProfileManager?: LlmProfileManager;
    sessionPersistencePath?: string | false;
  }) {
    const sessionId = options?.sessionId ?? crypto.randomUUID();
    const providerId = options?.providerId ?? `sloppy-session-${sessionId}`;

    this.runtime = new SessionRuntime({
      config: options?.config,
      sessionId,
      title: options?.title,
      ignoredProviderIds: [providerId],
      llmProfileManager: options?.llmProfileManager,
      sessionPersistencePath: options?.sessionPersistencePath,
    });

    this.providerId = providerId;
    this.provider = new AgentSessionProvider(this.runtime, {
      providerId: this.providerId,
      providerName: options?.providerName,
    });
    this.socketPath = options?.socketPath ?? defaultSocketPath(this.providerId);

    SessionService.sessions.set(sessionId, this);
  }

  static getActiveSessions(): {
    sessionId: string;
    providerId: string;
    socketPath: string;
    title?: string;
    workspaceRoot?: string;
    workspaceId?: string;
    projectId?: string;
  }[] {
    return Array.from(SessionService.sessions.values()).map((s) => {
      const snapshot = s.runtime.store.getSnapshot();
      return {
        sessionId: snapshot.session.sessionId,
        providerId: s.providerId,
        socketPath: s.socketPath,
        title: snapshot.session.title,
        workspaceRoot: snapshot.session.workspaceRoot,
        workspaceId: snapshot.session.workspaceId,
        projectId: snapshot.session.projectId,
      };
    });
  }

  static stopSession(sessionId: string): boolean {
    const session = SessionService.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    session.stop();
    return true;
  }

  async start(options?: { register?: boolean }): Promise<void> {
    // Start the runtime before exposing the socket so /llm and /composer
    // reflect the resolved profile state on the very first snapshot. Without
    // this, clients connecting before the first sendMessage() see llm.status
    // as "needs_credentials" even when env/stored credentials are ready, and
    // composer.send_message stays absent.
    await this.runtime.start();
    this.unixListener = listenUnix(this.provider.server, this.socketPath, {
      register: options?.register ?? true,
    });
  }

  stop(): void {
    const sessionId = this.runtime.store.getSnapshot().session.sessionId;
    SessionService.sessions.delete(sessionId);
    if (this.unixListener) {
      closeUnixListener(this.unixListener, this.socketPath);
    }
    this.unixListener = null;
    this.provider.stop();
    this.runtime.shutdown();
  }
}
