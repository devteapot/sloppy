import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionClient } from "../apps/tui/src/backend/session-client";
import { SessionSupervisorClient } from "../apps/tui/src/backend/supervisor-client";
import { startWsGateway, type WsGateway } from "../src/gateway";
import { type SessionSupervisor, startSessionSupervisor } from "../src/session/supervisor";

const tempPaths: string[] = [];
const gateways: WsGateway[] = [];
const listeners: Array<{ close: () => void }> = [];
const supervisors: SessionSupervisor[] = [];
const originalHome = process.env.HOME;

afterEach(async () => {
  for (const gateway of gateways.splice(0)) {
    await gateway.close();
  }
  for (const listener of listeners.splice(0)) {
    listener.close();
  }
  for (const supervisor of supervisors.splice(0)) {
    supervisor.stop();
  }
  if (originalHome == null) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

async function createTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(path);
  return path;
}

async function setupHome(): Promise<{ workspace: string }> {
  const home = await createTempDir("sloppy-gateway-home-");
  const workspace = await createTempDir("sloppy-gateway-workspace-");
  const configDir = join(home, ".sloppy");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.yaml"),
    [
      "llm:",
      "  defaultProfileId: test-openai",
      "  profiles:",
      "    - id: test-openai",
      "      endpointId: openai",
      "      model: gateway-test-model",
      "plugins:",
      "  terminal:",
      "    enabled: false",
      "  filesystem:",
      "    enabled: false",
      "  memory:",
      "    enabled: false",
      "  skills:",
      "    enabled: false",
    ].join("\n"),
    "utf8",
  );
  process.env.HOME = home;
  return { workspace };
}

async function startSupervisor(options?: { initial?: false }) {
  const { workspace } = await setupHome();
  const socketPath = `/tmp/slop/sloppy-gateway-sup-${crypto.randomUUID()}.sock`;
  const running = await startSessionSupervisor({
    socketPath,
    cwd: workspace,
    initial:
      options?.initial === false ? false : { sessionId: "gw-initial", title: "Gateway Initial" },
  });
  supervisors.push(running.supervisor);
  listeners.push(running.listener);
  return { socketPath, running };
}

async function startGateway(
  supervisorSocketPath: string,
  options?: Partial<Parameters<typeof startWsGateway>[0]>,
): Promise<WsGateway> {
  const gateway = await startWsGateway({
    supervisorSocketPath,
    port: 0,
    ...options,
  });
  gateways.push(gateway);
  return gateway;
}

function wsOutcome(
  url: string,
  options?: { headers?: Record<string, string>; closeOnOpen?: boolean },
): Promise<{ opened: boolean; code: number }> {
  return new Promise((resolve) => {
    const ws = options?.headers
      ? new WebSocket(url, { headers: options.headers } as unknown as string[])
      : new WebSocket(url);
    let opened = false;
    ws.onopen = () => {
      opened = true;
      if (options?.closeOnOpen) {
        ws.close();
      }
    };
    ws.onclose = (event) => resolve({ opened, code: event.code });
    ws.onerror = () => {
      // The close event carries the outcome; errors always precede it.
    };
  });
}

function withToken(url: string, token: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("token", token);
  return parsed.toString();
}

describe("WS gateway", () => {
  test("relays the supervisor and its sessions over a single port", async () => {
    const { socketPath } = await startSupervisor();
    const gateway = await startGateway(socketPath);
    expect(gateway.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/api\/supervisor$/);

    const origin = new URL(gateway.url);
    const removedSupervisorRoute = await wsOutcome(`${origin.protocol}//${origin.host}/supervisor`);
    expect(removedSupervisorRoute.opened).toBe(false);
    const removedSessionRoute = await wsOutcome(
      `${origin.protocol}//${origin.host}/sessions/gw-initial`,
    );
    expect(removedSessionRoute.opened).toBe(false);

    const sessionClient = new SessionClient(gateway.sessionUrl("gw-initial"));
    try {
      const snapshot = await sessionClient.connect();
      expect(snapshot.session.sessionId).toBe("gw-initial");
    } finally {
      sessionClient.disconnect();
    }
  });

  test("relays supervisor invokes and revives dormant sessions on redial", async () => {
    const { socketPath } = await startSupervisor();
    const gateway = await startGateway(socketPath);

    const supervisor = new SessionSupervisorClient(gateway.url, { reconnect: false });
    try {
      await supervisor.connect();

      // create_session is intercepted by the supervisor's own listener wiring;
      // it working through the relay proves the byte-level pipe preserves it.
      const created = await supervisor.createSession({
        sessionId: "gw-second",
        title: "Second",
      });
      expect(created.id).toBe("gw-second");

      const live = new SessionClient(gateway.sessionUrl("gw-second"));
      try {
        const snapshot = await live.connect();
        expect(snapshot.session.sessionId).toBe("gw-second");
      } finally {
        live.disconnect();
      }

      // The supervisor refuses to stop the selected session; switch away first.
      await supervisor.switchSession("gw-initial");
      await supervisor.stopSession("gw-second");
      const dormant = await wsOutcome(gateway.sessionUrl("gw-second"));
      expect(dormant.opened).toBe(true);
      expect(dormant.code).toBe(4503);

      // Redial immediately after select_session: the route table must observe
      // the fresh socket via its refresh-on-miss query, not just the mirror.
      await supervisor.switchSession("gw-second");
      const revived = new SessionClient(gateway.sessionUrl("gw-second"));
      try {
        const snapshot = await revived.connect();
        expect(snapshot.session.sessionId).toBe("gw-second");
      } finally {
        revived.disconnect();
      }
    } finally {
      supervisor.disconnect();
    }
  });

  test("returns 404 for unknown sessions before upgrading", async () => {
    const { socketPath } = await startSupervisor({ initial: false });
    const gateway = await startGateway(socketPath);

    const outcome = await wsOutcome(gateway.sessionUrl("does-not-exist"));
    expect(outcome.opened).toBe(false);
  });

  test("requires the configured token on upgrades", async () => {
    const { socketPath } = await startSupervisor({ initial: false });
    const gateway = await startGateway(socketPath, { token: "secret-token" });

    const denied = await wsOutcome(gateway.url);
    expect(denied.opened).toBe(false);

    const client = new SessionSupervisorClient(withToken(gateway.url, "secret-token"), {
      reconnect: false,
    });
    try {
      await client.connect();
    } finally {
      client.disconnect();
    }
  });

  test("a custom authorize hook replaces the default policy", async () => {
    const { socketPath } = await startSupervisor({ initial: false });
    const gateway = await startGateway(socketPath, {
      authorize: (req) =>
        req.headers.get("x-gateway-ok") === "yes" ? null : new Response("nope", { status: 403 }),
    });

    const denied = await wsOutcome(gateway.url);
    expect(denied.opened).toBe(false);

    const allowed = await wsOutcome(gateway.url, {
      headers: { "x-gateway-ok": "yes" },
      closeOnOpen: true,
    });
    expect(allowed.opened).toBe(true);
  });

  test("serves discovery and stays up without a supervisor socket", async () => {
    const gateway = await startGateway(
      `/tmp/slop/sloppy-gateway-missing-${crypto.randomUUID()}.sock`,
    );

    const response = await fetch(`http://127.0.0.1:${gateway.port}/.well-known/sloppy`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      transport: { type: string; url: string };
      paths: {
        supervisor: string;
        sessionTemplate: string;
      };
    };
    expect(body.transport.type).toBe("ws");
    expect(body.transport.url).toBe(gateway.url);
    expect(body.paths.supervisor).toBe("/api/supervisor");
    expect(body.paths.sessionTemplate).toBe("/api/sessions/{sessionId}");
    const removedDiscovery = await fetch(`http://127.0.0.1:${gateway.port}/.well-known/slop`);
    expect(removedDiscovery.status).toBe(404);

    // The supervisor relay path fails per-connection but the gateway survives.
    const outcome = await wsOutcome(gateway.url);
    expect(outcome.opened).toBe(true);
    expect(outcome.code).toBe(4502);
  });
});
