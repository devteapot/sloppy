import { describe, expect, test } from "bun:test";
import type { ResultMessage } from "@slop-ai/consumer/browser";

import type { VoiceConversationPluginConfig } from "../../../config/schema";
import type { PluginRuntimeContext, PluginTurnCompleteEvent } from "../../../session/plugins/types";
import type { SpeechProfileManager } from "../../../speech/profile-manager";
import type {
  PcmFormat,
  SttSession,
  SttSessionEvent,
  SttSessionOptions,
  TtsStream,
} from "../../../speech/types";
import type { AudioResourceLease } from "./audio-resource-arbiter";
import {
  createVoiceConversationPlugin as createRuntimeVoiceConversationPlugin,
  type VoiceConversationPluginOptions,
} from "./session";

const STT_FORMAT: PcmFormat = { encoding: "pcm16", sampleRate: 16000, channels: 1 };
const TTS_FORMAT: PcmFormat = { encoding: "pcm16", sampleRate: 24000, channels: 1 };

function createVoiceConversationPlugin(
  pluginConfig: VoiceConversationPluginConfig,
  manager: SpeechProfileManager,
  options: VoiceConversationPluginOptions = {},
) {
  return createRuntimeVoiceConversationPlugin(pluginConfig, manager, {
    resourceArbiter: {
      acquire: async (_owner, resources) => ({
        id: `test-lease-${crypto.randomUUID()}`,
        resources,
        release: async () => undefined,
      }),
      state: async () => [],
      subscribe: () => () => undefined,
    },
    ...options,
  });
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((r, fail) => {
    resolve = r;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const ok = (data?: unknown): ResultMessage => ({ type: "result", id: "1", status: "ok", data });

function config(
  overrides: Partial<VoiceConversationPluginConfig> = {},
): VoiceConversationPluginConfig {
  return {
    enabled: true,
    audio: {
      backend: "host",
      // Mic stream: enough zero bytes for several 10ms frames, then hold open.
      streamCommand: ["sh", "-c", "head -c 6400 /dev/zero; sleep 30"],
      // Player: consume the piped PCM and exit cleanly on stdin close.
      playStreamCommand: ["sh", "-c", "cat >/dev/null"],
      streamChunkMs: 10,
      providerId: "reachy",
    },
    embodiment: { enabled: false, providerId: "reachy", emotes: false },
    realtime: { autoStartMode: "continuous", defaultStartMode: "single_turn" },
    ...overrides,
  };
}

class FakeSttSession implements SttSession {
  appendedBytes = 0;
  endCalls = 0;
  closed = false;

  constructor(private readonly onEvent: (event: SttSessionEvent) => void) {}

  async appendAudio(pcm16: Uint8Array): Promise<void> {
    this.appendedBytes += pcm16.byteLength;
  }

  async end(): Promise<void> {
    this.endCalls += 1;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onEvent({ type: "closed", cause: "local" });
  }

  emit(event: SttSessionEvent): void {
    this.onEvent(event);
  }
}

class FakeTtsStream implements TtsStream {
  readonly format = TTS_FORMAT;
  texts: string[] = [];
  ended = false;
  aborted = false;
  /** When set, chunks() blocks after the first chunk until abort(). */
  private blockAfterFirstChunk: (() => void) | null = null;
  private blocked: Promise<void> | null = null;

  constructor(options: { blocking?: boolean } = {}) {
    if (options.blocking) {
      this.blocked = new Promise<void>((resolve) => {
        this.blockAfterFirstChunk = resolve;
      });
    }
  }

  appendText(text: string): void {
    this.texts.push(text);
  }

  end(): void {
    this.ended = true;
  }

  chunks(): AsyncIterable<Uint8Array> {
    const blocked = this.blocked;
    return async function* (this: FakeTtsStream) {
      yield new TextEncoder().encode("PCM");
      if (blocked) {
        await blocked;
      }
    }.call(this) as AsyncIterable<Uint8Array>;
  }

  abort(): void {
    this.aborted = true;
    this.blockAfterFirstChunk?.();
  }
}

type ManagerOptions = {
  localStt?: boolean;
  blockingTts?: boolean;
  prepareGate?: Promise<void>;
  tts?: boolean;
};

function fakeManager(options: ManagerOptions = {}) {
  const sessions: FakeSttSession[] = [];
  const ttsStreams: FakeTtsStream[] = [];
  const sessionWaiters: Array<(session: FakeSttSession) => void> = [];
  const selectionListeners = new Set<() => void>();

  function waitForSession(index: number): Promise<FakeSttSession> {
    if (sessions[index]) {
      return Promise.resolve(sessions[index]);
    }
    return new Promise((resolve) => {
      sessionWaiters[index] = resolve;
    });
  }

  function createSttAdapter() {
    return {
      inputFormat: STT_FORMAT,
      startSession: async (sessionOptions: SttSessionOptions) => {
        const session = new FakeSttSession(sessionOptions.onEvent);
        sessions.push(session);
        sessionWaiters[sessions.length - 1]?.(session);
        return session;
      },
    };
  }

  function createTtsAdapter() {
    return {
      outputFormat: TTS_FORMAT,
      openStream: () => {
        const stream = new FakeTtsStream({ blocking: options.blockingTts });
        ttsStreams.push(stream);
        return stream;
      },
    };
  }

  const manager = {
    async prepareActiveAdapters() {
      await options.prepareGate;
      const remote = options.localStt === false;
      return {
        generation: 0,
        stt: {
          destination: {
            profileId: "stt-p",
            endpointId: "stt-ep",
            label: "stt-ep",
            origin: remote ? "ws://dgx-spark.local:8000" : "ws://localhost:8000",
            remote,
            routingFingerprint: remote ? "remote-stt" : "local-stt",
          },
          createAdapter: createSttAdapter,
        },
        ...(options.tts === false
          ? {}
          : {
              tts: {
                destination: {
                  profileId: "tts-p",
                  endpointId: "tts-ep",
                  label: "tts-ep",
                  origin: "http://localhost:8880",
                  remote: false,
                  routingFingerprint: "local-tts",
                },
                createAdapter: createTtsAdapter,
              },
            }),
      };
    },
    async getSttState() {
      return { status: "ready", activeProfileId: "stt-p" };
    },
    async getTtsState() {
      return { status: "ready", activeProfileId: "tts-p" };
    },
    async activeSttEndpoint() {
      return {
        id: "stt-ep",
        config: {
          protocol: "realtime-stt",
          auth: { type: "none" },
          baseUrl:
            options.localStt === false
              ? "ws://dgx-spark.local:8000/v1/realtime"
              : "ws://localhost:8000/v1/realtime",
        },
      };
    },
    async activeTtsEndpoint() {
      return {
        id: "tts-ep",
        config: {
          protocol: "openai-speech",
          auth: { type: "none" },
          baseUrl: "http://localhost:8880/v1",
        },
      };
    },
    createSttAdapter,
    createTtsAdapter,
    onSelectionChange(listener: () => void) {
      selectionListeners.add(listener);
      return () => {
        selectionListeners.delete(listener);
      };
    },
  } as unknown as SpeechProfileManager;

  return {
    manager,
    sessions,
    ttsStreams,
    waitForSession,
    emitSelectionChange: () => {
      for (const listener of selectionListeners) listener();
    },
  };
}

type ExtensionRecordLike = { namespace: string; state: Record<string, unknown> };

function makeCtx(overrides: Partial<PluginRuntimeContext> = {}) {
  const extensions: Record<string, ExtensionRecordLike> = {};
  const audits: Array<Record<string, unknown>> = [];
  const turns: string[] = [];
  const publishes: Array<Record<string, unknown>> = [];
  const approvals = new Map<
    string,
    { execute: () => unknown | Promise<unknown>; autoApprovable?: boolean }
  >();
  let approvalSeq = 0;
  const defaultStartTurn = (request: { text: string }) => {
    turns.push(request.text);
    return { status: "started" as const, turnId: `t${turns.length}` };
  };
  const startTurn =
    (overrides.startTurn as (request: { text: string }) => { status: "started"; turnId: string }) ??
    defaultStartTurn;

  const ctx = {
    invokeProvider: async () => ok(),
    queryProvider: async () => ({
      id: "behavior",
      type: "control",
      properties: { emotions: ["cheerful1", "curious1", "fear1"] },
    }),
    startTurn,
    queueTurn: () => ({ status: "queued" as const, queuedMessageId: "queued-1", position: 1 }),
    drainQueue: () => undefined,
    turns: {
      submit: (request: { text: string }) => startTurn(request),
      drainQueue: () => undefined,
    },
    approvals: {
      request: (request: { execute: () => unknown | Promise<unknown> }) => {
        const approvalId = `approval-${++approvalSeq}`;
        approvals.set(approvalId, request);
        return { status: "approval_required" as const, approvalId };
      },
      cancel: (approvalId: string) => approvals.delete(approvalId),
    },
    transientState: {
      read: () => extensions.voice?.state,
      replace: (state: Record<string, unknown>) => {
        extensions.voice = { namespace: "voice", state };
        publishes.push({ ...state });
      },
      update: () => undefined,
      clear: () => {
        delete extensions.voice;
      },
    },
    audit: (event: Record<string, unknown>) => {
      audits.push(event);
    },
    snapshot: () => ({ session: { sessionId: `test-${crypto.randomUUID()}` }, extensions: {} }),
    store: {},
    ...overrides,
  } as unknown as PluginRuntimeContext;

  return {
    ctx,
    extensions,
    audits,
    turns,
    publishes,
    approvalRequests: approvals,
    approve: async (approvalId = `approval-${approvalSeq}`) => approvals.get(approvalId)?.execute(),
  };
}

function liveState(extensions: Record<string, ExtensionRecordLike>): Record<string, unknown> {
  return extensions.voice?.state ?? {};
}

type InvokableAction = { handler: (params: Record<string, unknown>) => unknown };

function conversationActions(
  plugin: ReturnType<typeof createVoiceConversationPlugin>,
  ctx: PluginRuntimeContext,
) {
  const actionFor = (name: "start_listening" | "stop_listening") => {
    const node = plugin.sessionNodes?.(ctx)[0]?.build(ctx);
    const actions = node?.actions as unknown as Record<string, InvokableAction> | undefined;
    const selected = actions?.[name];
    if (!selected) {
      throw new Error(`conversation node is missing ${name}`);
    }
    return selected;
  };
  let startAction: InvokableAction | undefined;
  return {
    start: (params: Record<string, unknown> = {}) => {
      startAction ??= actionFor("start_listening");
      return Promise.resolve(startAction.handler(params)) as Promise<Record<string, unknown>>;
    },
    stop: () =>
      Promise.resolve(actionFor("stop_listening").handler({})) as Promise<Record<string, unknown>>,
  };
}

const EMBODIED = { enabled: true, providerId: "reachy", emotes: true };

function recordingInvoker(
  result: (path: string, action: string) => ResultMessage | Promise<ResultMessage> = () => ok(),
) {
  const invokes: Array<{ path: string; action: string; params?: Record<string, unknown> }> = [];
  const invokeProvider = async (
    _providerId: string,
    path: string,
    action: string,
    params?: Record<string, unknown>,
  ) => {
    invokes.push({ path, action, params });
    return result(path, action);
  };
  return { invokes, invokeProvider };
}

/** Emit a final transcript (starts the plugin turn) and complete it with `response`. */
async function driveTurn(
  plugin: ReturnType<typeof createVoiceConversationPlugin>,
  ctx: PluginRuntimeContext,
  session: FakeSttSession,
  response: string,
): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
  session.emit({ type: "final", text: "user utterance" });
  plugin.onTurnComplete?.(
    {
      turnId: "t1",
      pluginTurn: {
        pluginId: "voice",
        runId: "vc-1",
        author: "reachy-voice",
        continuation: false,
      },
      result: { status: "completed", response },
      elapsedMs: 5,
      usedTools: false,
    },
    ctx,
  );
}

describe("voice-conversation streaming loop", () => {
  test(
    "continuous auto-start: stream → final → turn → streamed speak → re-arm",
    async () => {
      const { manager, ttsStreams, waitForSession } = fakeManager();
      const turnStarted = deferred<string>();
      const { ctx, extensions } = makeCtx({
        startTurn: (request: { text: string }) => {
          turnStarted.resolve(request.text);
          return { status: "started" as const, turnId: "t1" };
        },
      } as Partial<PluginRuntimeContext>);

      const plugin = createVoiceConversationPlugin(config(), manager);
      await plugin.onStartup?.(ctx);

      const session = await waitForSession(0);
      // Let some mic frames flow, then the provider VAD finalizes.
      await new Promise((r) => setTimeout(r, 50));
      session.emit({ type: "partial", delta: "hello", text: "hello" });
      session.emit({ type: "final", text: "hello realtime" });

      expect(await turnStarted.promise).toBe("hello realtime");
      expect(session.appendedBytes).toBeGreaterThan(0);
      expect(liveState(extensions).phase).toBe("thinking");

      const event: PluginTurnCompleteEvent = {
        turnId: "t1",
        pluginTurn: {
          pluginId: "voice",
          runId: "vc-1",
          author: "reachy-voice",
          continuation: false,
        },
        result: { status: "completed", response: "**Done!** All tests pass." },
        elapsedMs: 5,
        usedTools: false,
      };
      plugin.onTurnComplete?.(event, ctx);

      // The reply streams through TTS and the loop re-arms a second session.
      const second = await waitForSession(1);
      expect(second).toBeDefined();
      expect(ttsStreams).toHaveLength(1);
      expect(ttsStreams[0]?.texts).toEqual(["**Done!** All tests pass."]);
      expect(ttsStreams[0]?.ended).toBe(true);
      expect(liveState(extensions).last_transcript).toBe("hello realtime");

      plugin.onShutdown?.(ctx);
    },
    { timeout: 5000 },
  );

  test("continuous auto-start creates a Session approval before remote egress", async () => {
    const { manager, sessions, waitForSession } = fakeManager({ localStt: false });
    const { ctx, extensions, approve, approvalRequests } = makeCtx();

    const plugin = createVoiceConversationPlugin(config(), manager);
    await plugin.onStartup?.(ctx);
    await new Promise((r) => setTimeout(r, 30));

    expect(sessions).toHaveLength(0);
    expect(liveState(extensions).phase).toBe("needs_approval");
    expect([...approvalRequests.values()][0]?.autoApprovable).toBe(false);

    const result = (await approve()) as Record<string, unknown>;
    expect(result.status).toBe("started");
    expect(await waitForSession(0)).toBeDefined();

    plugin.onShutdown?.(ctx);
  });

  test("STT-only runs acquire microphone ownership without blocking the speaker", async () => {
    const resources: string[][] = [];
    const arbiter = {
      acquire: async (_owner: unknown, keys: readonly string[]) => {
        resources.push([...keys]);
        return {
          id: "stt-only",
          resources: keys,
          release: async () => undefined,
        };
      },
      state: async () => [],
      subscribe: () => () => undefined,
    };
    const { manager, waitForSession } = fakeManager({ tts: false });
    const { ctx } = makeCtx();
    const plugin = createVoiceConversationPlugin(config(), manager, { resourceArbiter: arbiter });

    await plugin.onStartup?.(ctx);
    await waitForSession(0);

    expect(resources).toEqual([["host:default:input"]]);
    await plugin.onShutdown?.(ctx);
  });

  test("second start_listening while starting reports already_active", async () => {
    const { manager, sessions } = fakeManager();
    const { ctx } = makeCtx();
    const plugin = createVoiceConversationPlugin(
      config({ realtime: { autoStartMode: "off", defaultStartMode: "single_turn" } }),
      manager,
    );
    await plugin.onStartup?.(ctx);

    const actions = conversationActions(plugin, ctx);
    const [first, second] = await Promise.all([actions.start(), actions.start()]);

    expect(first.status).toBe("started");
    expect(second.status).toBe("already_active");
    await new Promise((r) => setTimeout(r, 50));
    expect(sessions).toHaveLength(1);

    plugin.onShutdown?.(ctx);
  });

  test("stop during plan preparation cannot revive audio", async () => {
    const preparation = deferred();
    const { manager, sessions } = fakeManager({ prepareGate: preparation.promise });
    const { ctx, extensions } = makeCtx();
    const plugin = createVoiceConversationPlugin(
      config({ realtime: { autoStartMode: "off", defaultStartMode: "single_turn" } }),
      manager,
    );
    await plugin.onStartup?.(ctx);
    const actions = conversationActions(plugin, ctx);

    const starting = actions.start();
    await Bun.sleep(0);
    expect(liveState(extensions).phase).toBe("preparing");
    await actions.stop();

    expect(await starting).toMatchObject({ status: "cancelled" });
    expect(sessions).toHaveLength(0);
    expect(liveState(extensions).phase).toBe("idle");
    await plugin.onShutdown?.(ctx);
  });

  test("preparation timeout clears lifecycle blockers", async () => {
    const preparation = deferred();
    const { manager } = fakeManager({ prepareGate: preparation.promise });
    const { ctx, extensions } = makeCtx();
    const plugin = createVoiceConversationPlugin(
      config({ realtime: { autoStartMode: "off", defaultStartMode: "single_turn" } }),
      manager,
      { prepareTimeoutMs: 5 },
    );
    await plugin.onStartup?.(ctx);

    const result = await conversationActions(plugin, ctx).start();

    expect(result).toMatchObject({ status: "error" });
    expect(liveState(extensions).error).toContain("timed out");
    expect(plugin.autoCloseBlockers?.(ctx)).toEqual([]);
    await plugin.onShutdown?.(ctx);
  });

  test("stop during resource acquisition releases the late lease", async () => {
    const acquisition = deferred<AudioResourceLease>();
    let released = false;
    const arbiter = {
      acquire: () => acquisition.promise,
      state: async () => [],
      subscribe: () => () => undefined,
    };
    const { manager, sessions } = fakeManager();
    const { ctx, extensions } = makeCtx();
    const plugin = createVoiceConversationPlugin(
      config({ realtime: { autoStartMode: "off", defaultStartMode: "single_turn" } }),
      manager,
      { resourceArbiter: arbiter },
    );
    await plugin.onStartup?.(ctx);
    const actions = conversationActions(plugin, ctx);

    const starting = actions.start();
    while (liveState(extensions).phase !== "acquiring") await Bun.sleep(1);
    const stopping = actions.stop();
    acquisition.resolve({
      id: "late-lease",
      resources: ["host:input"],
      release: async () => {
        released = true;
      },
    });

    await stopping;
    expect(await starting).toMatchObject({ status: "cancelled" });
    expect(released).toBe(true);
    expect(sessions).toHaveLength(0);
    expect(liveState(extensions).phase).toBe("idle");
    await plugin.onShutdown?.(ctx);
  });

  test("a failed late-lease release remains tracked for stop retry", async () => {
    const acquisition = deferred<AudioResourceLease>();
    let allowRelease = false;
    let releaseAttempts = 0;
    const arbiter = {
      acquire: () => acquisition.promise,
      state: async () => [],
      subscribe: () => () => undefined,
    };
    const { manager } = fakeManager();
    const { ctx, extensions } = makeCtx();
    const plugin = createVoiceConversationPlugin(
      config({ realtime: { autoStartMode: "off", defaultStartMode: "single_turn" } }),
      manager,
      { resourceArbiter: arbiter },
    );
    await plugin.onStartup?.(ctx);
    const actions = conversationActions(plugin, ctx);

    const starting = actions.start();
    while (liveState(extensions).phase !== "acquiring") await Bun.sleep(1);
    const stopping = actions.stop();
    acquisition.resolve({
      id: "late-retry-lease",
      resources: ["host:input"],
      release: async () => {
        releaseAttempts += 1;
        if (!allowRelease) throw new Error("late release failed");
      },
    });

    await expect(stopping).resolves.toMatchObject({ status: "error" });
    expect(await starting).toMatchObject({ status: "cancelled" });
    expect(liveState(extensions).phase).toBe("error");
    allowRelease = true;
    expect(await actions.stop()).toMatchObject({ status: "stopped" });
    expect(releaseAttempts).toBeGreaterThanOrEqual(2);
    expect(liveState(extensions).phase).toBe("idle");
    await plugin.onShutdown?.(ctx);
  });

  test("an acquisition rejected during stop does not break cleanup", async () => {
    const acquisition = deferred<AudioResourceLease>();
    const arbiter = {
      acquire: () => acquisition.promise,
      state: async () => [],
      subscribe: () => () => undefined,
    };
    const { manager } = fakeManager();
    const { ctx, extensions } = makeCtx();
    const plugin = createVoiceConversationPlugin(
      config({ realtime: { autoStartMode: "off", defaultStartMode: "single_turn" } }),
      manager,
      { resourceArbiter: arbiter },
    );
    await plugin.onStartup?.(ctx);
    const actions = conversationActions(plugin, ctx);
    const starting = actions.start();
    while (liveState(extensions).phase !== "acquiring") await Bun.sleep(1);
    const stopping = actions.stop();
    acquisition.reject(new Error("device arbitration failed"));

    expect(await stopping).toMatchObject({ status: "stopped" });
    expect(await starting).toMatchObject({ status: "cancelled" });
    expect(liveState(extensions).phase).toBe("idle");
    await plugin.onShutdown?.(ctx);
  });

  test("failed lease cleanup keeps stop available and can be retried", async () => {
    let releaseAttempts = 0;
    const arbiter = {
      acquire: async (_owner: unknown, resources: readonly string[]) => ({
        id: "retry-cleanup",
        resources,
        release: async () => {
          releaseAttempts += 1;
          if (releaseAttempts === 1) throw new Error("temporary cleanup failure");
        },
      }),
      state: async () => [],
      subscribe: () => () => undefined,
    };
    const { manager, waitForSession } = fakeManager({ tts: false });
    const { ctx, extensions } = makeCtx();
    const plugin = createVoiceConversationPlugin(
      config({ realtime: { autoStartMode: "off", defaultStartMode: "single_turn" } }),
      manager,
      { resourceArbiter: arbiter },
    );
    await plugin.onStartup?.(ctx);
    const actions = conversationActions(plugin, ctx);
    await actions.start();
    await waitForSession(0);

    expect(await actions.stop()).toMatchObject({ status: "error" });
    const failedNode = plugin.sessionNodes?.(ctx)[0]?.build(ctx);
    expect(failedNode?.actions).toHaveProperty("stop_listening");
    expect(await actions.stop()).toMatchObject({ status: "stopped" });
    expect(releaseAttempts).toBe(2);
    expect(liveState(extensions).phase).toBe("idle");
    await plugin.onShutdown?.(ctx);
  });

  test("shutdown waits for and releases an in-flight acquisition", async () => {
    const acquisition = deferred<AudioResourceLease>();
    let releases = 0;
    const arbiter = {
      acquire: () => acquisition.promise,
      state: async () => [],
      subscribe: () => () => undefined,
    };
    const { manager } = fakeManager();
    const { ctx, extensions } = makeCtx();
    const plugin = createVoiceConversationPlugin(
      config({ realtime: { autoStartMode: "off", defaultStartMode: "single_turn" } }),
      manager,
      { resourceArbiter: arbiter },
    );
    await plugin.onStartup?.(ctx);
    const starting = conversationActions(plugin, ctx).start();
    while (liveState(extensions).phase !== "acquiring") await Bun.sleep(1);
    const shutdown = plugin.onShutdown?.(ctx);
    let released = false;
    acquisition.resolve({
      id: "shutdown-lease",
      resources: ["host:input"],
      release: async () => {
        if (!released) {
          released = true;
          releases += 1;
        }
      },
    });

    await shutdown;
    await starting;
    expect(releases).toBe(1);
    expect(liveState(extensions).phase).toBe("idle");
  });

  test("busy Session queues voice ingress and speaks when the queued turn completes", async () => {
    const { manager, ttsStreams, waitForSession } = fakeManager();
    const submissions: Array<{
      pluginId: string;
      runId: string;
      text: string;
      author: string;
      metadata?: Record<string, unknown>;
    }> = [];
    const { ctx, extensions } = makeCtx({
      turns: {
        submit: (request) => {
          submissions.push(request);
          return { status: "queued" as const, queuedMessageId: "voice-queued", position: 1 };
        },
        drainQueue: () => undefined,
      },
    } as Partial<PluginRuntimeContext>);
    const plugin = createVoiceConversationPlugin(config(), manager);
    await plugin.onStartup?.(ctx);

    const session = await waitForSession(0);
    session.emit({ type: "final", text: "do not drop me" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(liveState(extensions).phase).toBe("queued");
    expect(submissions[0]?.text).toBe("do not drop me");

    const queued = submissions[0];
    if (!queued) throw new Error("voice turn was not submitted");
    const accepted = plugin.acceptQueuedTurn?.(
      {
        id: "voice-queued",
        status: "queued",
        text: queued.text,
        createdAt: new Date().toISOString(),
        author: queued.author,
        source: "plugin",
        pluginId: queued.pluginId,
        pluginRunId: queued.runId,
      },
      ctx,
    );
    expect(accepted?.metadata?.voiceRunId).toBeString();
    plugin.onTurnComplete?.(
      {
        turnId: "queued-turn",
        pluginTurn: {
          pluginId: "voice",
          runId: queued.runId,
          author: queued.author,
          continuation: false,
          metadata: accepted?.metadata,
        },
        result: { status: "completed", response: "queued reply" },
        elapsedMs: 5,
        usedTools: false,
      },
      ctx,
    );

    await waitForSession(1);
    expect(ttsStreams[0]?.texts).toEqual(["queued reply"]);
    plugin.onShutdown?.(ctx);
  });

  test("profile changes stop the frozen run and release its lifecycle blocker", async () => {
    const { manager, waitForSession, emitSelectionChange } = fakeManager();
    const { ctx, extensions } = makeCtx();
    const plugin = createVoiceConversationPlugin(config(), manager);
    await plugin.onStartup?.(ctx);
    const session = await waitForSession(0);

    expect(plugin.autoCloseBlockers?.(ctx)).toHaveLength(1);
    emitSelectionChange();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(session.closed).toBe(true);
    expect(liveState(extensions).phase).toBe("idle");
    expect(liveState(extensions).error).toContain("Speech profile changed");
    expect(plugin.autoCloseBlockers?.(ctx)).toEqual([]);
    plugin.onShutdown?.(ctx);
  });

  test(
    "unexpected session closes restart with exponential backoff",
    async () => {
      const { manager, waitForSession } = fakeManager();
      const { ctx, extensions } = makeCtx();
      const delays: number[] = [];
      const plugin = createVoiceConversationPlugin(
        config({
          audio: {
            backend: "host",
            // No mic data: keeps appendAudio from resetting the backoff.
            streamCommand: ["sh", "-c", "sleep 30"],
            playStreamCommand: ["sh", "-c", "cat >/dev/null"],
            streamChunkMs: 10,
            providerId: "reachy",
          },
        }),
        manager,
        {
          delayFn: async (ms) => {
            delays.push(ms);
          },
        },
      );
      await plugin.onStartup?.(ctx);

      for (let i = 0; i < 3; i++) {
        const session = await waitForSession(i);
        await new Promise((r) => setTimeout(r, 10));
        session.emit({ type: "closed", cause: "remote", code: 1006, reason: "service died" });
      }
      await waitForSession(3);

      expect(delays).toEqual([500, 1000, 2000]);
      expect((liveState(extensions).restart_attempt as number) >= 3).toBe(true);

      plugin.onShutdown?.(ctx);
    },
    { timeout: 5000 },
  );

  test("stop cancels restart backoff and clears its lifecycle blocker", async () => {
    const { manager, waitForSession, sessions } = fakeManager();
    const { ctx, extensions } = makeCtx();
    const delayStarted = deferred();
    const plugin = createVoiceConversationPlugin(config(), manager, {
      delayFn: (_ms, signal) =>
        new Promise<void>((resolve) => {
          delayStarted.resolve(undefined);
          signal?.addEventListener("abort", () => resolve(), { once: true });
        }),
    });
    await plugin.onStartup?.(ctx);
    const session = await waitForSession(0);
    session.emit({ type: "closed", cause: "remote", code: 1006, reason: "service died" });
    await delayStarted.promise;

    expect(liveState(extensions).phase).toBe("restarting");
    await conversationActions(plugin, ctx).stop();
    await Bun.sleep(5);

    expect(sessions).toHaveLength(1);
    expect(liveState(extensions).phase).toBe("idle");
    expect(plugin.autoCloseBlockers?.(ctx)).toEqual([]);
    await plugin.onShutdown?.(ctx);
  });

  test("partial transcripts publish through transient State with throttling", async () => {
    const { manager, waitForSession } = fakeManager();
    const { ctx, extensions } = makeCtx();
    const plugin = createVoiceConversationPlugin(config(), manager);
    await plugin.onStartup?.(ctx);

    const session = await waitForSession(0);
    await new Promise((r) => setTimeout(r, 20));
    session.emit({ type: "partial", delta: "hel", text: "hel" });
    expect(liveState(extensions).partial_transcript).toBe("hel");

    // A burst inside the throttle window publishes via the trailing flush.
    session.emit({ type: "partial", delta: "lo", text: "hello" });
    session.emit({ type: "partial", delta: " wor", text: "hello wor" });
    expect(liveState(extensions).partial_transcript).toBe("hel");
    await new Promise((r) => setTimeout(r, 250));
    expect(liveState(extensions).partial_transcript).toBe("hello wor");

    plugin.onShutdown?.(ctx);
  });

  test(
    "stop_listening mid-speech aborts the TTS stream and playback",
    async () => {
      const { manager, ttsStreams, waitForSession } = fakeManager({ blockingTts: true });
      const turnStarted = deferred<void>();
      const { ctx, extensions } = makeCtx({
        startTurn: () => {
          turnStarted.resolve();
          return { status: "started" as const, turnId: "t1" };
        },
      } as Partial<PluginRuntimeContext>);
      const plugin = createVoiceConversationPlugin(config(), manager);
      await plugin.onStartup?.(ctx);

      const session = await waitForSession(0);
      await new Promise((r) => setTimeout(r, 20));
      session.emit({ type: "final", text: "say something long" });
      await turnStarted.promise;

      plugin.onTurnComplete?.(
        {
          turnId: "t1",
          pluginTurn: {
            pluginId: "voice",
            runId: "vc-1",
            author: "reachy-voice",
            continuation: false,
          },
          result: { status: "completed", response: "a very long reply" },
          elapsedMs: 5,
          usedTools: false,
        },
        ctx,
      );

      // Wait until speaking actually started (TTS stream opened).
      const start = Date.now();
      while (ttsStreams.length === 0 && Date.now() - start < 2000) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(ttsStreams).toHaveLength(1);

      const actions = conversationActions(plugin, ctx);
      await actions.stop();
      await new Promise((r) => setTimeout(r, 100));

      expect(ttsStreams[0]?.aborted).toBe(true);
      expect(liveState(extensions).phase).toBe("idle");

      plugin.onShutdown?.(ctx);
    },
    { timeout: 5000 },
  );

  test("stop_listening during thinking suppresses the spoken reply", async () => {
    const { manager, ttsStreams, waitForSession } = fakeManager();
    const turnStarted = deferred<void>();
    const { ctx, extensions } = makeCtx({
      startTurn: () => {
        turnStarted.resolve();
        return { status: "started" as const, turnId: "t1" };
      },
    } as Partial<PluginRuntimeContext>);
    const plugin = createVoiceConversationPlugin(config(), manager);
    await plugin.onStartup?.(ctx);

    const session = await waitForSession(0);
    await new Promise((r) => setTimeout(r, 20));
    session.emit({ type: "final", text: "question" });
    await turnStarted.promise;

    const actions = conversationActions(plugin, ctx);
    await actions.stop();

    plugin.onTurnComplete?.(
      {
        turnId: "t1",
        pluginTurn: {
          pluginId: "voice",
          runId: "vc-1",
          author: "reachy-voice",
          continuation: false,
        },
        result: { status: "completed", response: "should not be spoken" },
        elapsedMs: 5,
        usedTools: false,
      },
      ctx,
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(ttsStreams).toHaveLength(0);
    expect(liveState(extensions).phase).toBe("idle");

    plugin.onShutdown?.(ctx);
  });

  test("does nothing when disabled", async () => {
    const { manager, sessions } = fakeManager();
    const { ctx, extensions } = makeCtx();
    const plugin = createVoiceConversationPlugin(config({ enabled: false }), manager);
    await plugin.onStartup?.(ctx);
    await new Promise((r) => setTimeout(r, 20));

    expect(sessions).toHaveLength(0);
    expect(extensions.voice).toBeUndefined();
  });

  test("no-marker reply with embodiment still streams once", async () => {
    const { manager, ttsStreams, waitForSession } = fakeManager();
    const { ctx } = makeCtx();
    const plugin = createVoiceConversationPlugin(config({ embodiment: EMBODIED }), manager);
    await plugin.onStartup?.(ctx);

    await driveTurn(plugin, ctx, await waitForSession(0), "Nothing special here.");
    await waitForSession(1);

    expect(ttsStreams).toHaveLength(1);
    expect(ttsStreams[0]?.texts).toEqual(["Nothing special here."]);

    plugin.onShutdown?.(ctx);
  });

  test("ignores turn-complete events from other plugins", async () => {
    const { manager, ttsStreams } = fakeManager();
    const { ctx } = makeCtx();
    const plugin = createVoiceConversationPlugin(
      config({ realtime: { autoStartMode: "off", defaultStartMode: "single_turn" } }),
      manager,
    );
    await plugin.onStartup?.(ctx);

    plugin.onTurnComplete?.(
      {
        turnId: "x",
        pluginTurn: { pluginId: "some-other-plugin", runId: "r", author: "u", continuation: false },
        result: { status: "completed", response: "not ours" },
        elapsedMs: 1,
        usedTools: false,
      },
      ctx,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(ttsStreams).toHaveLength(0);

    plugin.onShutdown?.(ctx);
  });
});

describe("inline emote markers", () => {
  test(
    "marker reply splits TTS segments and fires the emotion muted",
    async () => {
      const { manager, ttsStreams, waitForSession } = fakeManager();
      const { invokes, invokeProvider } = recordingInvoker();
      const { ctx } = makeCtx({ invokeProvider } as Partial<PluginRuntimeContext>);
      const plugin = createVoiceConversationPlugin(config({ embodiment: EMBODIED }), manager);
      await plugin.onStartup?.(ctx);

      await driveTurn(
        plugin,
        ctx,
        await waitForSession(0),
        "Bad news. [emote:fear1] But it's fine!",
      );
      await waitForSession(1); // speak finished; continuous loop re-armed

      expect(ttsStreams).toHaveLength(2);
      expect(ttsStreams[0]?.texts).toEqual(["Bad news."]);
      expect(ttsStreams[1]?.texts).toEqual(["But it's fine!"]);
      const emotes = invokes.filter((call) => call.action === "play_emotion");
      expect(emotes).toEqual([
        { path: "/behavior", action: "play_emotion", params: { name: "fear1", sound: false } },
      ]);

      plugin.onShutdown?.(ctx);
    },
    { timeout: 5000 },
  );

  test(
    "unknown emotion name is stripped without firing",
    async () => {
      const { manager, ttsStreams, waitForSession } = fakeManager();
      const { invokes, invokeProvider } = recordingInvoker();
      const { ctx } = makeCtx({ invokeProvider } as Partial<PluginRuntimeContext>);
      const plugin = createVoiceConversationPlugin(config({ embodiment: EMBODIED }), manager);
      await plugin.onStartup?.(ctx);

      await driveTurn(plugin, ctx, await waitForSession(0), "Hello [emote:bogus] world.");
      await waitForSession(1);

      expect(ttsStreams).toHaveLength(1);
      expect(ttsStreams[0]?.texts).toEqual(["Hello world."]);
      expect(invokes.filter((call) => call.action === "play_emotion")).toHaveLength(0);

      plugin.onShutdown?.(ctx);
    },
    { timeout: 5000 },
  );

  test(
    "vocabulary unavailable: markers fire unvalidated",
    async () => {
      const { manager, waitForSession } = fakeManager();
      const { invokes, invokeProvider } = recordingInvoker();
      const { ctx } = makeCtx({
        invokeProvider,
        queryProvider: async () => {
          throw new Error("provider down");
        },
      } as Partial<PluginRuntimeContext>);
      const plugin = createVoiceConversationPlugin(config({ embodiment: EMBODIED }), manager);
      await plugin.onStartup?.(ctx);

      await driveTurn(plugin, ctx, await waitForSession(0), "Hi [emote:bogus] there.");
      await waitForSession(1);

      const emotes = invokes.filter((call) => call.action === "play_emotion");
      expect(emotes).toHaveLength(1);
      expect(emotes[0]?.params).toEqual({ name: "bogus", sound: false });

      plugin.onShutdown?.(ctx);
    },
    { timeout: 5000 },
  );

  test(
    "barge-in mid-speech stops the fired emotion",
    async () => {
      const { manager, ttsStreams, waitForSession } = fakeManager({ blockingTts: true });
      const { invokes, invokeProvider } = recordingInvoker();
      const { ctx } = makeCtx({ invokeProvider } as Partial<PluginRuntimeContext>);
      const plugin = createVoiceConversationPlugin(config({ embodiment: EMBODIED }), manager);
      await plugin.onStartup?.(ctx);

      await driveTurn(plugin, ctx, await waitForSession(0), "[emote:cheerful1] A long reply.");

      const start = Date.now();
      while (ttsStreams.length === 0 && Date.now() - start < 2000) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const actions = conversationActions(plugin, ctx);
      await actions.stop();
      await new Promise((r) => setTimeout(r, 100));

      expect(invokes.some((call) => call.path === "/behavior" && call.action === "stop")).toBe(
        true,
      );

      plugin.onShutdown?.(ctx);
    },
    { timeout: 5000 },
  );

  test(
    "no barge-in: a finished reply does not stop the emotion",
    async () => {
      const { manager, waitForSession } = fakeManager();
      const { invokes, invokeProvider } = recordingInvoker();
      const { ctx } = makeCtx({ invokeProvider } as Partial<PluginRuntimeContext>);
      const plugin = createVoiceConversationPlugin(config({ embodiment: EMBODIED }), manager);
      await plugin.onStartup?.(ctx);

      await driveTurn(plugin, ctx, await waitForSession(0), "[emote:cheerful1] Short.");
      await waitForSession(1);

      expect(invokes.some((call) => call.action === "stop")).toBe(false);

      plugin.onShutdown?.(ctx);
    },
    { timeout: 5000 },
  );

  test(
    "emotes disabled: markers stripped, nothing fires",
    async () => {
      const { manager, ttsStreams, waitForSession } = fakeManager();
      const { invokes, invokeProvider } = recordingInvoker();
      const { ctx } = makeCtx({ invokeProvider } as Partial<PluginRuntimeContext>);
      const plugin = createVoiceConversationPlugin(
        config({ embodiment: { ...EMBODIED, emotes: false } }),
        manager,
      );
      await plugin.onStartup?.(ctx);

      await driveTurn(plugin, ctx, await waitForSession(0), "Bad news. [emote:fear1] It's fine!");
      await waitForSession(1);

      expect(ttsStreams).toHaveLength(1);
      expect(ttsStreams[0]?.texts).toEqual(["Bad news. It's fine!"]);
      expect(invokes.filter((call) => call.action === "play_emotion")).toHaveLength(0);

      plugin.onShutdown?.(ctx);
    },
    { timeout: 5000 },
  );

  test(
    "markers-only reply fires the emotion without opening TTS",
    async () => {
      const { manager, ttsStreams, waitForSession } = fakeManager();
      const { invokes, invokeProvider } = recordingInvoker();
      const { ctx } = makeCtx({ invokeProvider } as Partial<PluginRuntimeContext>);
      const plugin = createVoiceConversationPlugin(config({ embodiment: EMBODIED }), manager);
      await plugin.onStartup?.(ctx);

      await driveTurn(plugin, ctx, await waitForSession(0), "[emote:cheerful1]");
      await waitForSession(1);

      expect(ttsStreams).toHaveLength(0);
      expect(invokes.filter((call) => call.action === "play_emotion")).toHaveLength(1);

      plugin.onShutdown?.(ctx);
    },
    { timeout: 5000 },
  );

  test(
    "head wobble skips ticks on error results instead of dying",
    async () => {
      const { manager, ttsStreams, waitForSession } = fakeManager({ blockingTts: true });
      const { invokes, invokeProvider } = recordingInvoker((path, action) =>
        path === "/head" && action === "set_pose"
          ? {
              type: "result",
              id: "1",
              status: "error",
              error: { code: "conflict", message: "Robot is busy" },
            }
          : ok(),
      );
      const { ctx } = makeCtx({ invokeProvider } as Partial<PluginRuntimeContext>);
      const plugin = createVoiceConversationPlugin(config({ embodiment: EMBODIED }), manager);
      await plugin.onStartup?.(ctx);

      await driveTurn(plugin, ctx, await waitForSession(0), "A long blocked reply.");
      const start = Date.now();
      while (ttsStreams.length === 0 && Date.now() - start < 2000) {
        await new Promise((r) => setTimeout(r, 5));
      }
      await new Promise((r) => setTimeout(r, 350)); // several wobble ticks

      const poses = invokes.filter((call) => call.action === "set_pose");
      expect(poses.length).toBeGreaterThanOrEqual(2); // loop kept going
      expect(invokes.filter((call) => call.action === "set_antennas")).toHaveLength(0);

      const actions = conversationActions(plugin, ctx);
      await actions.stop();
      plugin.onShutdown?.(ctx);
    },
    { timeout: 5000 },
  );

  test(
    "head wobble stops on thrown transport errors",
    async () => {
      const { manager, ttsStreams, waitForSession } = fakeManager({ blockingTts: true });
      const { invokes, invokeProvider } = recordingInvoker((path) => {
        if (path === "/head") {
          throw new Error("provider gone");
        }
        return ok();
      });
      const { ctx } = makeCtx({ invokeProvider } as Partial<PluginRuntimeContext>);
      const plugin = createVoiceConversationPlugin(config({ embodiment: EMBODIED }), manager);
      await plugin.onStartup?.(ctx);

      await driveTurn(plugin, ctx, await waitForSession(0), "A long blocked reply.");
      const start = Date.now();
      while (ttsStreams.length === 0 && Date.now() - start < 2000) {
        await new Promise((r) => setTimeout(r, 5));
      }
      await new Promise((r) => setTimeout(r, 350));

      expect(invokes.filter((call) => call.action === "set_pose")).toHaveLength(1);

      const actions = conversationActions(plugin, ctx);
      await actions.stop();
      plugin.onShutdown?.(ctx);
    },
    { timeout: 5000 },
  );
});
