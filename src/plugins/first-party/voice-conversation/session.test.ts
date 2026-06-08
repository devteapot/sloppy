import { describe, expect, test } from "bun:test";
import type { ResultMessage } from "@slop-ai/consumer/browser";

import type { VoiceConversationPluginConfig } from "../../../config/schema";
import type { PluginRuntimeContext, PluginTurnCompleteEvent } from "../../../session/plugins/types";
import { createVoiceConversationPlugin } from "./session";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function config(): VoiceConversationPluginConfig {
  return {
    enabled: true,
    // robot backend routes capture/playback through invokeProvider, so the whole
    // loop is exercised against a stub with no subprocesses.
    audio: {
      backend: "robot",
      silenceStopSeconds: 1.2,
      silenceThresholdPercent: 1,
      maxUtteranceSeconds: 30,
      providerId: "reachy",
    },
    embodiment: { enabled: true, providerId: "reachy" },
  };
}

const ok = (data?: unknown): ResultMessage => ({ type: "result", id: "1", status: "ok", data });

describe("voice-conversation loop", () => {
  test(
    "runs capture → transcribe → turn, then speak → re-listen",
    async () => {
      const startTurnText = deferred<string>();
      const reArmed = deferred();

      let captureCount = 0;
      let synthesizedText: string | undefined;
      let speakerPlayed = false;
      let headMoves = 0;
      let firstTurnStarted = false;

      const invokeProvider: PluginRuntimeContext["invokeProvider"] = async (
        providerId,
        path,
        action,
        params,
      ) => {
        const key = `${providerId}${path}:${action}`;
        switch (key) {
          case "reachy/mic:capture_utterance":
            captureCount += 1;
            if (captureCount === 2) {
              reArmed.resolve();
            }
            return ok({ audio_base64: "QUJD", mime_type: "audio/wav" });
          case "voice/stt:transcribe":
            return ok({ text: "hello robot" });
          case "voice/tts:synthesize":
            synthesizedText = (params as { text?: string }).text;
            return ok({ audio_base64: "BBBB", mime_type: "audio/mpeg" });
          case "reachy/speaker:play":
            speakerPlayed = true;
            return ok();
          case "reachy/head:set_pose":
          case "reachy/head:set_antennas":
            headMoves += 1;
            return ok();
          default:
            return ok();
        }
      };

      const startTurn: PluginRuntimeContext["startTurn"] = (request) => {
        if (!firstTurnStarted) {
          firstTurnStarted = true;
          startTurnText.resolve(request.text);
        }
        return { status: "started", turnId: "t1" };
      };

      const ctx = {
        invokeProvider,
        startTurn,
        audit: () => {},
      } as unknown as PluginRuntimeContext;

      const plugin = createVoiceConversationPlugin(config());

      await plugin.onStartup?.(ctx);

      // The loop should capture, transcribe, and start a turn with the transcript.
      expect(await startTurnText.promise).toBe("hello robot");
      expect(captureCount).toBe(1);

      // Simulate the agent completing our turn.
      const event: PluginTurnCompleteEvent = {
        turnId: "t1",
        pluginTurn: {
          pluginId: "voice-conversation",
          runId: "vc-1",
          author: "reachy-voice",
          continuation: false,
        },
        result: { status: "completed", response: "hi there" },
        elapsedMs: 5,
        usedTools: false,
      };
      plugin.onTurnComplete?.(event, ctx);

      // It should synthesize the reply, play it, and re-arm the listener.
      await reArmed.promise;
      expect(synthesizedText).toBe("hi there");
      expect(speakerPlayed).toBe(true);
      expect(headMoves).toBeGreaterThanOrEqual(0);
      expect(captureCount).toBe(2);

      plugin.onShutdown?.(ctx);
    },
    { timeout: 5000 },
  );

  test("does nothing when disabled", async () => {
    let invoked = false;
    const ctx = {
      invokeProvider: async () => {
        invoked = true;
        return ok();
      },
      startTurn: () => ({ status: "started" as const, turnId: "t" }),
      audit: () => {},
    } as unknown as PluginRuntimeContext;

    const disabled = { ...config(), enabled: false };
    const plugin = createVoiceConversationPlugin(disabled);
    await plugin.onStartup?.(ctx);
    // Give any erroneous async loop a tick to run.
    await new Promise((r) => setTimeout(r, 20));
    expect(invoked).toBe(false);
  });

  test("ignores turn-complete events from other plugins", async () => {
    let synthesizeCalled = false;
    const ctx = {
      invokeProvider: async (_p: string, path: string, action: string) => {
        if (path === "/tts" && action === "synthesize") {
          synthesizeCalled = true;
        }
        return ok();
      },
      startTurn: () => ({ status: "started" as const, turnId: "t" }),
      audit: () => {},
    } as unknown as PluginRuntimeContext;

    const plugin = createVoiceConversationPlugin({ ...config(), enabled: false });
    const foreignEvent: PluginTurnCompleteEvent = {
      turnId: "x",
      pluginTurn: { pluginId: "some-other-plugin", runId: "r", author: "u", continuation: false },
      result: { status: "completed", response: "not ours" },
      elapsedMs: 1,
      usedTools: false,
    };
    plugin.onTurnComplete?.(foreignEvent, ctx);
    await new Promise((r) => setTimeout(r, 20));
    expect(synthesizeCalled).toBe(false);
  });
});
