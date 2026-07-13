import { describe, expect, test } from "bun:test";

import { endpointForSession } from "../apps/tui/src/backend/supervisor-client";

describe("endpointForSession", () => {
  const session = { id: "session-1", socketPath: "/tmp/slop/session-1.sock" };

  test("returns the unix socket path for local supervisors", () => {
    expect(endpointForSession(session, "/tmp/slop/supervisor.sock")).toBe(session.socketPath);
    expect(endpointForSession(session, null)).toBe(session.socketPath);
    expect(endpointForSession(session, undefined)).toBe(session.socketPath);
  });

  test("derives a sibling sessions path from a ws supervisor endpoint", () => {
    expect(endpointForSession(session, "ws://127.0.0.1:8787/api/supervisor")).toBe(
      "ws://127.0.0.1:8787/api/sessions/session-1",
    );
  });

  test("preserves proxy prefixes and wss scheme", () => {
    expect(endpointForSession(session, "wss://example.com/gw/api/supervisor")).toBe(
      "wss://example.com/gw/api/sessions/session-1",
    );
  });

  test("preserves auth query parameters", () => {
    expect(endpointForSession(session, "ws://127.0.0.1:8787/api/supervisor?token=secret")).toBe(
      "ws://127.0.0.1:8787/api/sessions/session-1?token=secret",
    );
  });

  test("encodes session ids that need escaping", () => {
    const odd = { id: "weird id/with#chars", socketPath: "/tmp/slop/odd.sock" };
    expect(endpointForSession(odd, "ws://127.0.0.1:8787/api/supervisor")).toBe(
      "ws://127.0.0.1:8787/api/sessions/weird%20id%2Fwith%23chars",
    );
  });
});
