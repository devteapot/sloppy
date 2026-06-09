import { describe, expect, test } from "bun:test";
import { SlopConsumer, WebSocketClientTransport } from "@slop-ai/consumer";

import { SessionClient } from "../apps/tui/src/backend/session-client";
import { SessionService } from "../src/session/service";
import { createTestConfig } from "./helpers/config";

function withToken(url: string, token: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("token", token);
  return parsed.toString();
}

describe("SessionService WebSocket transport", () => {
  test("serves the public session provider over WebSocket", async () => {
    const service = new SessionService({
      config: createTestConfig(),
      sessionId: "ws-session",
      sessionPersistencePath: false,
      socketPath: `/tmp/slop/ws-session-${crypto.randomUUID()}.sock`,
      webSocket: {
        host: "127.0.0.1",
        port: 0,
      },
    });

    try {
      await service.start({ register: false });
      expect(service.webSocketUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/slop$/);

      const consumer = new SlopConsumer(new WebSocketClientTransport(service.webSocketUrl!));
      try {
        const hello = await consumer.connect();
        expect(hello.provider.id).toBe("sloppy-session-ws-session");
        const session = await consumer.query("/session", 1);
        expect(session.properties?.session_id).toBe("ws-session");
      } finally {
        consumer.disconnect();
      }

      const client = new SessionClient(service.webSocketUrl!);
      try {
        const snapshot = await client.connect();
        expect(snapshot.session.sessionId).toBe("ws-session");
      } finally {
        client.disconnect();
      }
    } finally {
      service.stop();
    }
  });

  test("requires configured token on WebSocket upgrades", async () => {
    const service = new SessionService({
      config: createTestConfig(),
      sessionId: "ws-token-session",
      sessionPersistencePath: false,
      socketPath: `/tmp/slop/ws-token-session-${crypto.randomUUID()}.sock`,
      webSocket: {
        host: "127.0.0.1",
        port: 0,
        token: "secret-token",
      },
    });

    try {
      await service.start({ register: false });
      expect(service.webSocketUrl).toBeDefined();

      await expect(
        new SlopConsumer(new WebSocketClientTransport(service.webSocketUrl!)).connect(),
      ).rejects.toThrow("WebSocket connection failed");

      const consumer = new SlopConsumer(
        new WebSocketClientTransport(withToken(service.webSocketUrl!, "secret-token")),
      );
      try {
        const hello = await consumer.connect();
        expect(hello.provider.id).toBe("sloppy-session-ws-token-session");
      } finally {
        consumer.disconnect();
      }
    } finally {
      service.stop();
    }
  });
});
