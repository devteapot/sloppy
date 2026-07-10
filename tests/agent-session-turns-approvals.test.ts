import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";
import { InProcessTransport } from "../src/providers/in-process";
import { AgentSessionProvider } from "../src/session/provider";
import { SessionRuntime } from "../src/session/runtime";
import {
  createApprovalHarnessFactory,
  createCancelableStreamingAgentFactory,
  createDeferred,
  createQueuedTurnHarnessFactory,
  createStreamingAgentFactory,
  createTestProfileManager,
  TEST_CONFIG,
} from "./helpers/agent-session-provider-harness";

describe("AgentSessionProvider — turns and approvals", () => {
  test("send_message updates transcript, activity, and turn state", async () => {
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-test",
      agentFactory: createStreamingAgentFactory(),
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-test",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      const invokeResult = await consumer.invoke("/composer", "send_message", {
        text: "hello session",
      });
      expect(invokeResult.status).toBe("ok");

      await runtime.waitForIdle();

      const transcript = await consumer.query("/transcript", 5);
      expect(transcript.children?.map((child) => child.id)).toEqual([
        expect.stringMatching(/^msg-/),
        expect.stringMatching(/^msg-/),
      ]);
      expect(transcript.children?.[0]?.properties?.role).toBe("user");
      expect(transcript.children?.[1]?.properties?.role).toBe("assistant");
      expect(transcript.children?.[1]?.children?.[0]?.id).toBe("content");

      const turn = await consumer.query("/turn", 1);
      expect(turn.properties?.state).toBe("idle");

      const activity = await consumer.query("/activity", 2);
      const kinds = activity.children?.map((child) => child.properties?.kind);
      expect(kinds).toContain("model_call");
      expect(kinds).toContain("tool_call");
      expect(kinds).toContain("tool_result");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session runtime writes durable turn lifecycle audit events", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-session-audit-"));
    const logPath = join(root, "events.jsonl");
    const previousEventLog = process.env.SLOPPY_EVENT_LOG;
    process.env.SLOPPY_EVENT_LOG = logPath;
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-audit",
      agentFactory: createStreamingAgentFactory(),
      llmProfileManager: createTestProfileManager(),
      actorId: "agent-audit",
      actorName: "Audit Agent",
    });

    try {
      await runtime.start();
      const result = await runtime.sendMessage("audit this turn");
      if (result.status !== "started") {
        throw new Error(`Expected started turn, got ${result.status}`);
      }
      await runtime.waitForIdle();

      const records = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string; [key: string]: unknown });
      expect(records.map((record) => record.kind)).toContain("turn_started");
      expect(records.map((record) => record.kind)).toContain("turn_completed");
      expect(records.map((record) => record.kind)).toContain("tool_started");
      expect(records.map((record) => record.kind)).toContain("tool_completed");
      const turnStarted = records.find((record) => record.kind === "turn_started");
      const turnCompleted = records.find((record) => record.kind === "turn_completed");
      expect(turnStarted?.turnId).toBe(result.turnId);
      expect(turnStarted?.actor).toMatchObject({ id: "agent-audit", name: "Audit Agent" });
      expect(turnCompleted?.turnId).toBe(result.turnId);
    } finally {
      runtime.shutdown();
      if (previousEventLog === undefined) {
        delete process.env.SLOPPY_EVENT_LOG;
      } else {
        process.env.SLOPPY_EVENT_LOG = previousEventLog;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("send_message during an active turn queues and drains FIFO", async () => {
    const harness = createQueuedTurnHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-blocking",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-queue",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      const first = await consumer.invoke("/composer", "send_message", { text: "first" });
      expect(first.status).toBe("ok");
      expect((first.data as { status?: string }).status).toBe("started");

      const second = await consumer.invoke("/composer", "send_message", { text: "second" });
      expect(second.status).toBe("ok");
      expect((second.data as { status?: string }).status).toBe("queued");
      expect((second.data as { position?: number }).position).toBe(1);

      let queue = await consumer.query("/queue", 2);
      expect(queue.properties?.count).toBe(1);
      expect(queue.children?.[0]?.properties?.text).toBe("second");
      expect(
        queue.children?.[0]?.affordances?.some((affordance) => affordance.action === "cancel") ??
          false,
      ).toBe(true);

      harness.resolve(0, "first done");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(harness.messages).toEqual(["first", "second"]);

      queue = await consumer.query("/queue", 2);
      expect(queue.properties?.count).toBe(0);

      harness.resolve(1, "second done");
      await runtime.waitForIdle();

      const transcript = await consumer.query("/transcript", 5);
      expect(
        transcript.children
          ?.filter((child) => child.properties?.role === "user")
          .map((child) => child.children?.[0]?.children?.[0]?.properties?.text),
      ).toEqual(["first", "second"]);
      expect(
        transcript.children
          ?.filter((child) => child.properties?.role === "assistant")
          .map((child) => child.children?.[0]?.children?.[0]?.properties?.text),
      ).toEqual(["first done", "second done"]);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("cancel_turn aborts an active model turn and preserves partial text", async () => {
    const harness = createCancelableStreamingAgentFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-cancel-running",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-cancel-running",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      await consumer.invoke("/composer", "send_message", {
        text: "start then cancel",
      });

      const cancelResult = await consumer.invoke("/turn", "cancel_turn", {});
      expect(cancelResult.status).toBe("ok");

      await runtime.waitForIdle();

      const turn = await consumer.query("/turn", 1);
      expect(turn.properties?.state).toBe("idle");
      expect(turn.properties?.message).toBe("Turn cancelled by user.");
      expect(
        turn.affordances?.some((affordance) => affordance.action === "cancel_turn") ?? false,
      ).toBe(false);

      const transcript = await consumer.query("/transcript", 5);
      expect(transcript.children?.[1]?.properties?.role).toBe("assistant");
      expect(transcript.children?.[1]?.properties?.state).toBe("complete");
      expect(transcript.children?.[1]?.children?.[0]?.children?.[0]?.properties?.text).toBe(
        "Thinking...",
      );

      const activity = await consumer.query("/activity", 3);
      expect(activity.children?.[0]?.properties?.kind).toBe("model_call");
      expect(activity.children?.[0]?.properties?.status).toBe("cancelled");
    } finally {
      harness.resolve("finished");
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session mirrors provider approvals and forwards approve", async () => {
    const harness = createApprovalHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-approval",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-approval",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      await consumer.invoke("/composer", "send_message", {
        text: "remove the file",
      });
      harness.emitApprovalSnapshot();

      const approvals = await consumer.query("/approvals", 3);
      expect(approvals.children?.length).toBe(1);
      expect(approvals.children?.[0]?.properties?.status).toBe("pending");

      const approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");
      const approveResult = await consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      expect(approveResult.status).toBe("ok");

      await runtime.waitForIdle();

      // Session resume now resolves approvals through the hub-owned queue
      // directly (Agent.resolveApprovalDirect) rather than re-invoking the
      // provider's `/approvals/{id}.approve` action. This avoids
      // double-wrapping the inner ResultMessage.
      expect(harness.approveCalls).toEqual(["approval-1"]);

      const turn = await consumer.query("/turn", 1);
      expect(turn.properties?.state).toBe("idle");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session approval mode auto-approves pending approvals across the session", async () => {
    const harness = createApprovalHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-auto-approval",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-auto-approval",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      let approvals = await consumer.query("/approvals", 1);
      expect(approvals.properties?.approval_mode).toBe("normal");
      expect(approvals.affordances?.map((item) => item.action)).toContain("set_mode");

      const modeResult = await consumer.invoke("/approvals", "set_mode", { mode: "auto" });
      expect(modeResult.status).toBe("ok");

      approvals = await consumer.query("/approvals", 1);
      expect(approvals.properties?.approval_mode).toBe("auto");

      await consumer.invoke("/composer", "send_message", {
        text: "remove the file",
      });
      harness.emitApprovalSnapshot();

      await runtime.waitForIdle();

      expect(harness.approveCalls).toEqual(["approval-1"]);
      const turn = await consumer.query("/turn", 1);
      expect(turn.properties?.state).toBe("idle");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session approval mode attempts failed auto-approval once per pending item", async () => {
    const harness = createApprovalHarnessFactory({
      approveError: new Error("provider approval failed"),
    });
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-auto-approval-failure",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-auto-approval-failure",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      await consumer.invoke("/approvals", "set_mode", { mode: "auto" });
      await consumer.invoke("/composer", "send_message", {
        text: "remove the file",
      });
      harness.emitApprovalSnapshot();
      await runtime.waitForIdle();

      harness.emitApprovalSnapshot();
      await runtime.waitForIdle();

      expect(harness.approveCalls).toEqual(["approval-1"]);
      const approvals = await consumer.query("/approvals", 3);
      expect(approvals.children?.[0]?.properties?.status).toBe("pending");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("cycling approval mode to normal clears failed auto-approval attempts", async () => {
    const harness = createApprovalHarnessFactory({
      approveError: new Error("provider approval failed"),
    });
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-auto-approval-retry-reset",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-auto-approval-retry-reset",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      await consumer.invoke("/approvals", "set_mode", { mode: "auto" });
      await consumer.invoke("/composer", "send_message", {
        text: "remove the file",
      });
      harness.emitApprovalSnapshot();
      await runtime.waitForIdle();

      await consumer.invoke("/approvals", "set_mode", { mode: "normal" });
      await consumer.invoke("/approvals", "set_mode", { mode: "auto" });
      harness.emitApprovalSnapshot();
      await runtime.waitForIdle();

      expect(harness.approveCalls).toEqual(["approval-1", "approval-1"]);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session approval mode chains scheduled auto-approval passes", async () => {
    const gate = createDeferred<void>();
    const harness = createApprovalHarnessFactory({
      providerInvokeDelay: gate.promise,
    });
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-auto-approval-chained",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-auto-approval-chained",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      await consumer.invoke("/approvals", "set_mode", { mode: "auto" });
      harness.emitApprovalSnapshot({
        providerId: "sloppy-session-child",
        approvalId: "approval-child-1",
        approvalProvider: "skills",
        path: "/skills/one",
        action: "skill_manage",
        mirrorLineage: ["skills"],
      });

      for (let attempt = 0; attempt < 20 && harness.providerInvokes.length === 0; attempt += 1) {
        await Bun.sleep(5);
      }
      expect(harness.providerInvokes).toEqual([
        {
          providerId: "sloppy-session-child",
          path: "/approvals/approval-child-1",
          action: "approve",
          params: undefined,
        },
      ]);

      harness.emitApprovalSnapshot({
        providerId: "sloppy-session-child",
        approvalId: "approval-child-2",
        approvalProvider: "skills",
        path: "/skills/two",
        action: "skill_manage",
        mirrorLineage: ["skills"],
      });
      await Bun.sleep(25);
      expect(harness.providerInvokes).toHaveLength(1);

      gate.resolve(undefined);
      await runtime.waitForIdle();

      expect(harness.providerInvokes).toEqual([
        {
          providerId: "sloppy-session-child",
          path: "/approvals/approval-child-1",
          action: "approve",
          params: undefined,
        },
        {
          providerId: "sloppy-session-child",
          path: "/approvals/approval-child-2",
          action: "approve",
          params: undefined,
        },
      ]);
    } finally {
      gate.resolve(undefined);
      provider.stop();
      runtime.shutdown();
    }
  });

  test("async-approved action surfaces task_id to the resumed turn", async () => {
    // Regression: previously the session resume path went through
    // `agent.invokeProvider("/approvals/{id}", "approve")`. The provider
    // action returned the queue's inner ResultMessage, which the SLOP server
    // then wrapped a second time as `data` of an outer `{status:"ok"}`
    // ResultMessage. The runtime read `result.status` and `result.data.taskId`
    // off the outer wrapper, so an async-approved action with
    // `{status:"accepted", data:{taskId:"task-123"}}` was visible to the
    // session as `status:"ok"` with no task identity, breaking task mirroring.
    //
    // The fix routes session resume through `Agent.resolveApprovalDirect`
    // (i.e. `hub.approvals.approve(id)`) so the inner ResultMessage is passed
    // through unchanged.
    const harness = createApprovalHarnessFactory({
      approveResult: {
        type: "result",
        id: "inv-approval-async",
        status: "accepted",
        data: { taskId: "task-123" },
      },
    });
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-approval-async",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-approval-async",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      await consumer.invoke("/composer", "send_message", {
        text: "kick off a long job",
      });
      harness.emitApprovalSnapshot();

      const approvals = await consumer.query("/approvals", 3);
      const approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");

      const approveResult = await consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      expect(approveResult.status).toBe("ok");

      await runtime.waitForIdle();

      // Direct queue path was used (not the per-provider /approvals action).
      expect(harness.approveCalls).toEqual(["approval-1"]);

      // The inner ResultMessage flows through to the resumed turn; the
      // session sees the underlying `accepted` status and the `task_id`.
      expect(harness.resumeCalls.length).toBe(1);
      const resumed = harness.resumeCalls[0]!;
      expect(resumed.status).toBe("accepted");
      expect(resumed.taskId).toBe("task-123");
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session forwards non-turn mirrored approval actions to the source provider", async () => {
    const harness = createApprovalHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-forward-approval",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-forward-approval",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      harness.emitApprovalSnapshot({
        providerId: "sloppy-session-child",
        approvalId: "approval-child",
        approvalProvider: "skills",
        path: "/skills/dual-model-development-loop",
        action: "skill_manage",
        reason: "Skill write requires approval.",
        mirrorLineage: ["skills"],
      });

      const approvals = await consumer.query("/approvals", 3);
      const approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");

      const approveResult = await consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      expect(approveResult.status).toBe("ok");

      expect(harness.approveCalls).toEqual([]);
      expect(harness.providerInvokes).toEqual([
        {
          providerId: "sloppy-session-child",
          path: "/approvals/approval-child",
          action: "approve",
          params: undefined,
        },
      ]);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("session forwards non-turn mirrored approval rejections to the source provider", async () => {
    const harness = createApprovalHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-forward-reject",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-forward-reject",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      harness.emitApprovalSnapshot({
        providerId: "sloppy-session-child",
        approvalId: "approval-child",
        approvalProvider: "skills",
        path: "/skills/dual-model-development-loop",
        action: "skill_manage",
        reason: "Skill write requires approval.",
        mirrorLineage: ["skills"],
      });

      const approvals = await consumer.query("/approvals", 3);
      const approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");

      const rejectResult = await consumer.invoke(`/approvals/${approvalId}`, "reject", {
        reason: "not now",
      });
      expect(rejectResult.status).toBe("ok");

      expect(harness.rejectCalls).toEqual([]);
      expect(harness.providerInvokes).toEqual([
        {
          providerId: "sloppy-session-child",
          path: "/approvals/approval-child",
          action: "reject",
          params: { reason: "not now" },
        },
      ]);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });

  test("cancel_turn rejects a pending approval turn without resuming the model", async () => {
    const harness = createApprovalHarnessFactory();
    const runtime = new SessionRuntime({
      config: TEST_CONFIG,
      sessionId: "sess-cancel-approval",
      agentFactory: harness.factory,
      llmProfileManager: createTestProfileManager(),
    });
    const provider = new AgentSessionProvider(runtime, {
      providerId: "sloppy-session-cancel-approval",
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await runtime.start();
      await consumer.connect();
      await consumer.subscribe("/", 5);

      await consumer.invoke("/composer", "send_message", {
        text: "remove the file later",
      });
      harness.emitApprovalSnapshot();

      const cancelResult = await consumer.invoke("/turn", "cancel_turn", {});
      expect(cancelResult.status).toBe("ok");

      const turn = await consumer.query("/turn", 1);
      expect(turn.properties?.state).toBe("idle");
      expect(turn.properties?.message).toBe("Turn cancelled by user.");

      const approvals = await consumer.query("/approvals", 3);
      expect(approvals.children?.[0]?.properties?.status).toBe("rejected");

      expect(harness.rejectCalls).toEqual([
        { id: "approval-1", reason: "Turn cancelled by user." },
      ]);
    } finally {
      provider.stop();
      runtime.shutdown();
    }
  });
});
