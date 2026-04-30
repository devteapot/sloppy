import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

import type { SlopServer } from "@slop-ai/server";
import { listenUnix } from "@slop-ai/server/unix";

import type { SloppyConfig } from "../config/schema";
import type { LlmProfileManager } from "../llm/profile-manager";
import { AgentSessionProvider } from "./provider";
import { SessionRuntime } from "./runtime";

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function defaultSocketPath(providerId: string): string {
  return `/tmp/slop/${sanitizeSegment(providerId)}.sock`;
}

type UnixListener = { close: () => void };

type NdjsonConnection = {
  send(message: unknown): void;
  close(): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: () => void): void;
};

function removeSocketIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    if (code !== "ENOENT") {
      throw error;
    }
  }
}

function createNdjsonConnection(socket: Socket): NdjsonConnection {
  const messageHandlers: Array<(message: unknown) => void> = [];
  const closeHandlers: Array<() => void> = [];
  const rl = createInterface({ input: socket });

  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const message: unknown = JSON.parse(line);
      for (const handler of messageHandlers) {
        handler(message);
      }
    } catch {
      // Ignore malformed client input; the session provider is local-only and
      // individual bad lines should not tear down the listener.
    }
  });

  rl.on("close", () => {
    for (const handler of closeHandlers) {
      handler();
    }
  });

  return {
    send(message: unknown) {
      if (!socket.destroyed) {
        socket.write(`${JSON.stringify(message)}\n`);
      }
    },
    close() {
      socket.end();
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
  };
}

async function listenUnixReady(slop: SlopServer, socketPath: string): Promise<UnixListener> {
  removeSocketIfPresent(socketPath);
  mkdirSync(dirname(socketPath), { recursive: true });

  const server = createServer((socket: Socket) => {
    const connection = createNdjsonConnection(socket);
    slop.handleConnection(connection);
    connection.onMessage((message) => {
      slop.handleMessage(connection, message);
    });
    connection.onClose(() => {
      slop.handleDisconnect(connection);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      try {
        chmodSync(socketPath, 0o600);
      } catch {
        // Best-effort parity with @slop-ai/server/unix; a chmod failure should
        // not hide that the session listener itself is usable.
      }
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  }).catch((error) => {
    server.close();
    removeSocketIfPresent(socketPath);
    throw error;
  });

  return {
    close() {
      server.close();
      removeSocketIfPresent(socketPath);
    },
  };
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
  }) {
    const sessionId = options?.sessionId ?? crypto.randomUUID();
    const providerId = options?.providerId ?? `sloppy-session-${sessionId}`;

    this.runtime = new SessionRuntime({
      config: options?.config,
      sessionId,
      title: options?.title,
      ignoredProviderIds: [providerId],
      llmProfileManager: options?.llmProfileManager,
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
  }[] {
    return Array.from(SessionService.sessions.values()).map((s) => ({
      sessionId: s.runtime.store.getSnapshot().session.sessionId,
      providerId: s.providerId,
      socketPath: s.socketPath,
    }));
  }

  static stopSession(sessionId: string): boolean {
    const session = SessionService.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    session.stop();
    return true;
  }

  async start(options?: { register?: boolean; listen?: boolean }): Promise<void> {
    // Start the runtime before exposing the socket so /llm and /composer
    // reflect the resolved profile state on the very first snapshot. Without
    // this, clients connecting before the first sendMessage() see llm.status
    // as "needs_credentials" even when env/stored credentials are ready, and
    // composer.send_message stays absent.
    await this.runtime.start();
    if (options?.listen === false) {
      return;
    }
    if (options?.register === false) {
      this.unixListener = await listenUnixReady(this.provider.server, this.socketPath);
      return;
    }
    this.unixListener = listenUnix(this.provider.server, this.socketPath, { register: true });
  }

  stop(): void {
    const sessionId = this.runtime.store.getSnapshot().session.sessionId;
    SessionService.sessions.delete(sessionId);
    this.unixListener?.close();
    this.unixListener = null;
    this.provider.stop();
    this.runtime.shutdown();
  }
}
