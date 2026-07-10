import type { SloppyConfig } from "../config/schema";
import type { LlmProfileBindingRegistry, LlmProfileManager } from "../llm/profile-manager";
import { listenSessionClientProtocol } from "./client-protocol";
import { SessionRuntime } from "./runtime";
import type { ApprovalMode } from "./types";

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function defaultSocketPath(sessionId: string): string {
  return `/tmp/slop/sloppy-session-${sanitizeSegment(sessionId)}.sock`;
}

function throwCleanupErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, message);
  }
}

export class SessionService {
  private static sessions = new Map<string, SessionService>();

  readonly sessionId: string;
  readonly runtime: SessionRuntime;
  readonly socketPath: string;

  private listener: { close(): void } | null = null;
  private stopRequested = false;
  private stopComplete = false;
  private stopImmediateErrors: unknown[] = [];
  private stopCompletion: Promise<void> = Promise.resolve();

  constructor(options?: {
    config?: SloppyConfig;
    sessionId?: string;
    title?: string;
    socketPath?: string;
    llmProfileManager?: LlmProfileManager;
    llmProfileBindingRegistry?: LlmProfileBindingRegistry;
    llmProfileRevision?: number;
    sessionPersistencePath?: string | false;
    approvalMode?: ApprovalMode;
    configReloader?: () => Promise<SloppyConfig>;
    launchScope?: {
      key: string;
      root: string;
    };
  }) {
    const sessionId = options?.sessionId ?? crypto.randomUUID();
    this.sessionId = sessionId;

    this.runtime = new SessionRuntime({
      config: options?.config,
      sessionId,
      title: options?.title,
      llmProfileManager: options?.llmProfileManager,
      llmProfileBindingRegistry: options?.llmProfileBindingRegistry,
      llmProfileRevision: options?.llmProfileRevision,
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
        sessionId: s.sessionId,
        socketPath: s.socketPath,
        title: snapshot.session.title,
        workspaceRoot: snapshot.session.workspaceRoot,
        workspaceId: snapshot.session.workspaceId,
        projectId: snapshot.session.projectId,
      };
    });
  }

  static async stopSession(sessionId: string): Promise<boolean> {
    const session = SessionService.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    await session.stop();
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
      const errors: unknown[] = [error];
      try {
        await this.stopAndWait();
      } catch (cleanupError) {
        if (!errors.includes(cleanupError)) {
          errors.push(cleanupError);
        }
      }
      throwCleanupErrors(errors, "Session service startup and cleanup failed.");
    }
  }

  stop(): void {
    if (this.stopRequested) {
      return;
    }
    const cleanupErrors = this.beginStop();
    throwCleanupErrors(cleanupErrors, "Session service shutdown failed.");
  }

  async stopAndWait(): Promise<void> {
    const cleanupErrors = [...this.beginStop()];
    try {
      await this.stopCompletion;
    } catch (error) {
      if (!cleanupErrors.includes(error)) {
        cleanupErrors.push(error);
      }
    }
    throwCleanupErrors(cleanupErrors, "Session service shutdown failed.");
  }

  async waitForStopCompletion(): Promise<void> {
    this.beginStop();
    await this.stopCompletion;
  }

  isStopping(): boolean {
    return this.stopRequested && !this.stopComplete;
  }

  isStopped(): boolean {
    return this.stopComplete;
  }

  private beginStop(): readonly unknown[] {
    if (this.stopRequested) {
      return this.stopImmediateErrors;
    }
    this.stopRequested = true;
    try {
      this.listener?.close();
    } catch (error) {
      this.stopImmediateErrors.push(error);
    }
    this.listener = null;
    try {
      this.runtime.shutdown();
    } catch (error) {
      this.stopImmediateErrors.push(error);
    }

    const finish = () => {
      this.stopComplete = true;
      if (SessionService.sessions.get(this.sessionId) === this) {
        SessionService.sessions.delete(this.sessionId);
      }
    };
    this.stopCompletion = this.runtime.waitForShutdown().then(
      () => finish(),
      (error: unknown) => {
        finish();
        throw error;
      },
    );
    void this.stopCompletion.catch(() => undefined);
    if (this.runtime.isShutdownComplete()) {
      finish();
    }
    return this.stopImmediateErrors;
  }
}
