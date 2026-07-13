import type { SloppyConfig } from "../config/schema";
import type { LlmProfileManager } from "../llm/profile-manager";
import { listenSessionClientProtocol } from "./client-protocol";
import { SessionRuntime } from "./runtime";
import type { ApprovalMode } from "./types";

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function defaultSocketPath(sessionId: string): string {
  return `/tmp/slop/sloppy-session-${sanitizeSegment(sessionId)}.sock`;
}

export class SessionService {
  private static sessions = new Map<string, SessionService>();

  readonly runtime: SessionRuntime;
  readonly socketPath: string;

  private listener: { close(): void } | null = null;

  constructor(options?: {
    config?: SloppyConfig;
    sessionId?: string;
    title?: string;
    socketPath?: string;
    llmProfileManager?: LlmProfileManager;
    sessionPersistencePath?: string | false;
    approvalMode?: ApprovalMode;
    configReloader?: () => Promise<SloppyConfig>;
    launchScope?: {
      key: string;
      root: string;
    };
  }) {
    const sessionId = options?.sessionId ?? crypto.randomUUID();

    this.runtime = new SessionRuntime({
      config: options?.config,
      sessionId,
      title: options?.title,
      llmProfileManager: options?.llmProfileManager,
      sessionPersistencePath: options?.sessionPersistencePath,
      approvalMode: options?.approvalMode,
      configReloader: options?.configReloader,
      launchScope: options?.launchScope,
    });

    this.socketPath = options?.socketPath ?? defaultSocketPath(sessionId);

    SessionService.sessions.set(sessionId, this);
  }

  static getActiveSessions(): {
    sessionId: string;
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

  async start(): Promise<void> {
    try {
      // Start the runtime before exposing the socket so /llm and /composer
      // reflect the resolved profile state on the very first snapshot. Without
      // this, clients connecting before the first sendMessage() see llm.status
      // as "needs_credentials" even when env/stored credentials are ready, and
      // composer.send_message stays absent.
      await this.runtime.start();
      this.listener = listenSessionClientProtocol(this.runtime, this.socketPath);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    const sessionId = this.runtime.store.getSnapshot().session.sessionId;
    SessionService.sessions.delete(sessionId);
    this.listener?.close();
    this.listener = null;
    this.runtime.shutdown();
  }
}
