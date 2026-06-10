/**
 * Per-connection relay between a downstream WebSocket client and an upstream
 * unix-socket SLOP provider. The relay is deliberately protocol-blind: one WS
 * text frame maps to one NDJSON line and vice versa, with no SLOP parsing.
 * Listener-level behavior on the unix side (supervisor invoke interception,
 * client-lease tracking) is preserved because each WS client gets its own
 * upstream connection.
 *
 * The upstream dial uses Bun.connect rather than node:net — Bun's node:net
 * shim reports unix-socket connect failures (e.g. ENOENT) as unhandled
 * errors that bypass both try/catch and "error" listeners.
 */

export type RelayCloseInfo = { code: number; reason: string };

export const RELAY_CLOSE = {
  upstreamClosed: { code: 1000, reason: "upstream closed" },
  upstreamError: { code: 4502, reason: "upstream connection error" },
  supervisorUnavailable: { code: 4502, reason: "supervisor unavailable" },
  sessionNotLive: {
    code: 4503,
    reason: "session not live; invoke select_session on the supervisor first",
  },
  gatewayShutdown: { code: 1001, reason: "gateway shutting down" },
} as const satisfies Record<string, RelayCloseInfo>;

export type GatewaySocketData = {
  upstreamSocketPath: string;
  /** Close info sent when the upstream socket cannot be dialed. */
  unavailableClose: RelayCloseInfo;
  /** When set, the connection is closed immediately after the upgrade. */
  immediateClose?: RelayCloseInfo;
  relay?: Relay;
};

export type Relay = {
  handleFrame(message: string | Buffer): void;
  handleDrain(): void;
  handleClose(): void;
  destroy(): void;
};

export function startRelay(input: {
  ws: Bun.ServerWebSocket<GatewaySocketData>;
  upstreamSocketPath: string;
  unavailableClose: RelayCloseInfo;
  onEnd?: () => void;
}): Relay {
  const { ws } = input;
  // Separate decoders: the upstream one carries streaming state across
  // chunks; reusing it for whole-frame decodes would corrupt that state.
  const upstreamDecoder = new TextDecoder();
  const frameDecoder = new TextDecoder();
  const encoder = new TextEncoder();

  let closed = false;
  let upstream: Bun.Socket | null = null;
  let upstreamConnected = false;
  // Frames received before the upstream connect completes, and frames held
  // back while the upstream socket signals write backpressure. Flushed FIFO
  // so message order is preserved; the head chunk may be a partial remainder.
  const pendingChunks: Uint8Array[] = [];
  let waitingUpstreamDrain = false;
  let lineBuffer = "";

  const finish = (close?: RelayCloseInfo) => {
    if (closed) {
      return;
    }
    closed = true;
    upstream?.end();
    upstream = null;
    if (close) {
      try {
        ws.close(close.code, close.reason);
      } catch {
        // The downstream socket may already be gone; teardown is best-effort.
      }
    }
    input.onEnd?.();
  };

  const flushPending = () => {
    const socket = upstream;
    if (!socket) {
      return;
    }
    while (!waitingUpstreamDrain && !closed) {
      const chunk = pendingChunks[0];
      if (!chunk) {
        return;
      }
      const written = Math.max(socket.write(chunk), 0);
      if (written < chunk.byteLength) {
        pendingChunks[0] = chunk.subarray(written);
        waitingUpstreamDrain = true;
        return;
      }
      pendingChunks.shift();
    }
  };

  const forwardLines = (data: Uint8Array) => {
    lineBuffer += upstreamDecoder.decode(data, { stream: true });
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      // Bun returns -1 when the message was enqueued but the downstream
      // socket is backed up; pause the upstream until Bun reports drain.
      if (ws.send(line) === -1) {
        upstream?.pause();
      }
    }
  };

  void Bun.connect({
    unix: input.upstreamSocketPath,
    socket: {
      binaryType: "uint8array",
      open(socket) {
        if (closed) {
          socket.end();
          return;
        }
        upstream = socket;
        upstreamConnected = true;
        flushPending();
      },
      data(_socket, data) {
        if (!closed) {
          forwardLines(data as Uint8Array);
        }
      },
      drain() {
        waitingUpstreamDrain = false;
        flushPending();
      },
      close() {
        finish(RELAY_CLOSE.upstreamClosed);
      },
      error() {
        finish(upstreamConnected ? RELAY_CLOSE.upstreamError : input.unavailableClose);
      },
    },
  }).catch(() => {
    finish(input.unavailableClose);
  });

  return {
    handleFrame(message) {
      if (closed) {
        return;
      }
      const text = typeof message === "string" ? message : frameDecoder.decode(message);
      pendingChunks.push(encoder.encode(text.endsWith("\n") ? text : `${text}\n`));
      if (upstreamConnected && !waitingUpstreamDrain) {
        flushPending();
      }
    },
    handleDrain() {
      upstream?.resume();
    },
    handleClose() {
      finish();
    },
    destroy() {
      finish(RELAY_CLOSE.gatewayShutdown);
    },
  };
}
