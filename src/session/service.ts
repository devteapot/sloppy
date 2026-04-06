import { listenUnix } from "@slop-ai/server/unix";

import type { SloppyConfig } from "../config/schema";
import { AgentSessionProvider } from "./provider";
import { SessionRuntime } from "./runtime";

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function defaultSocketPath(providerId: string): string {
  return `/tmp/slop/${sanitizeSegment(providerId)}.sock`;
}

export class SessionService {
  readonly runtime: SessionRuntime;
  readonly provider: AgentSessionProvider;
  readonly providerId: string;
  readonly socketPath: string;

  private unixListener: { close: () => void } | null = null;

  constructor(options?: {
    config?: SloppyConfig;
    sessionId?: string;
    title?: string;
    providerId?: string;
    providerName?: string;
    socketPath?: string;
  }) {
    this.runtime = new SessionRuntime({
      config: options?.config,
      sessionId: options?.sessionId,
      title: options?.title,
    });

    this.providerId =
      options?.providerId ?? `sloppy-session-${this.runtime.store.getSnapshot().session.sessionId}`;
    this.provider = new AgentSessionProvider(this.runtime, {
      providerId: this.providerId,
      providerName: options?.providerName,
    });
    this.socketPath = options?.socketPath ?? defaultSocketPath(this.providerId);
  }

  async start(options?: { register?: boolean }): Promise<void> {
    await this.runtime.start();
    this.unixListener = listenUnix(this.provider.server, this.socketPath, {
      register: options?.register ?? true,
    });
  }

  stop(): void {
    this.unixListener?.close();
    this.unixListener = null;
    this.provider.stop();
    this.runtime.shutdown();
  }
}
