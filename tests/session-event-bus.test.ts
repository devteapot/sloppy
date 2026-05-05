import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentEventBus } from "../src/session/event-bus";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (!path) continue;
    await rm(path, { recursive: true, force: true });
  }
});

describe("createAgentEventBus", () => {
  test("logs sanitized params previews for normal tool start and completion events", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-events-"));
    tempPaths.push(root);
    const logPath = join(root, "events.jsonl");
    const eventBus = createAgentEventBus({
      logPath,
      actor: { id: "agent-1", name: "agent", kind: "agent" },
    });
    const invocation = {
      toolUseId: "tool-1",
      toolName: "terminal__session__execute",
      kind: "affordance" as const,
      providerId: "terminal",
      path: "/session",
      action: "execute",
      params: {
        command: "npm run build",
        apiKey: "secret-value",
      },
    };

    eventBus.callbacks.onToolEvent?.({
      kind: "started",
      invocation,
      summary: "terminal:execute /session",
    });
    eventBus.callbacks.onToolEvent?.({
      kind: "completed",
      invocation,
      summary: "terminal:execute /session",
      status: "ok",
    });
    eventBus.stop();

    const records = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0].paramsPreview).toContain("npm run build");
    expect(records[0].paramsPreview).not.toContain("secret-value");
    expect(records[0].paramsPreview).toContain("[redacted]");
    expect(records[1].paramsPreview).toBe(records[0].paramsPreview);
  });

  test("logs task state transitions from provider task snapshots once per version", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-events-"));
    tempPaths.push(root);
    const logPath = join(root, "events.jsonl");
    const eventBus = createAgentEventBus({
      logPath,
      actor: { id: "agent-1", name: "Agent", kind: "agent" },
    });

    const snapshot = {
      id: "tasks",
      type: "collection",
      children: [
        {
          id: "task-12345678",
          type: "item",
          properties: {
            id: "task-12345678",
            name: "build",
            status: "verifying",
            version: 3,
          },
        },
      ],
    };

    eventBus.callbacks.onProviderSnapshot?.({
      providerId: "delegation",
      path: "/tasks",
      tree: snapshot,
    });
    eventBus.callbacks.onProviderSnapshot?.({
      providerId: "delegation",
      path: "/tasks",
      tree: snapshot,
    });
    eventBus.stop();

    const records = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "task_state",
      providerId: "delegation",
      taskId: "task-12345678",
      taskName: "build",
      status: "verifying",
      version: 3,
    });
  });

  test("logs scheduler events", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-events-"));
    tempPaths.push(root);
    const logPath = join(root, "events.jsonl");
    const eventBus = createAgentEventBus({
      logPath,
      actor: { id: "meta-manager", name: "Meta Manager", kind: "agent" },
    });

    eventBus.publish({
      kind: "task_scheduled",
      taskId: "task-12345678",
      taskName: "build",
      version: 2,
      summary: "build was scheduled for delegation.",
    });
    eventBus.stop();

    const records = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "task_scheduled",
      taskId: "task-12345678",
      taskName: "build",
      version: 2,
      summary: "build was scheduled for delegation.",
    });
  });
});
