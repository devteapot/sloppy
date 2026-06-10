import { describe, expect, test } from "bun:test";

import { sloppyConfigSchema } from "../src/config/schema";
import type { InvokeContext, PolicyDecision } from "../src/core/policy";
import { createSpeechNetworkRule, endpointIsLocal } from "../src/plugins/first-party/voice/policy";
import type {
  SpeechProfileManager,
  SpeechSttEndpointConfig,
  SpeechTtsEndpointConfig,
} from "../src/speech/profile-manager";

const LOCAL_STT: SpeechSttEndpointConfig = {
  protocol: "realtime-stt",
  baseUrl: "ws://localhost:8000/v1/realtime",
  auth: { type: "none" },
};

const REMOTE_STT: SpeechSttEndpointConfig = {
  label: "DGX Nemotron ASR (realtime)",
  protocol: "realtime-stt",
  baseUrl: "ws://dgx-spark.local:8000/v1/realtime",
  auth: { type: "none" },
};

const LOCAL_TTS: SpeechTtsEndpointConfig = {
  protocol: "openai-speech",
  baseUrl: "http://localhost:8880/v1",
  auth: { type: "none" },
};

const CLOUD_TTS: SpeechTtsEndpointConfig = {
  label: "OpenAI Speech",
  protocol: "openai-speech",
  auth: { type: "env", env: "OPENAI_API_KEY" },
};

function fakeManager(
  stt: SpeechSttEndpointConfig | null,
  tts: SpeechTtsEndpointConfig | null,
): SpeechProfileManager {
  return {
    async activeSttEndpoint() {
      return stt ? { id: "stt-ep", config: stt } : null;
    },
    async activeTtsEndpoint() {
      return tts ? { id: "tts-ep", config: tts } : null;
    },
  } as unknown as SpeechProfileManager;
}

function invokeCtx(overrides: Partial<InvokeContext> = {}): InvokeContext {
  return {
    providerId: "sloppy-session-abc123",
    action: "start_listening",
    path: "/conversation",
    params: { mode: "continuous" },
    config: sloppyConfigSchema.parse({}) as unknown as InvokeContext["config"],
    ...overrides,
  };
}

async function decide(
  manager: SpeechProfileManager,
  overrides: Partial<InvokeContext> = {},
): Promise<PolicyDecision> {
  return createSpeechNetworkRule(manager).evaluate(invokeCtx(overrides));
}

describe("endpointIsLocal", () => {
  test("matches ws/wss/http/https localhost forms, requires no auth", () => {
    expect(endpointIsLocal({ type: "none" }, "ws://localhost:8000/v1/realtime")).toBe(true);
    expect(endpointIsLocal({ type: "none" }, "wss://127.0.0.1:8000")).toBe(true);
    expect(endpointIsLocal({ type: "none" }, "http://[::1]:8880/v1")).toBe(true);
    expect(endpointIsLocal({ type: "none" }, "ws://dgx-spark.local:8000")).toBe(false);
    expect(endpointIsLocal({ type: "env", env: "K" }, "http://localhost:8880")).toBe(false);
    expect(endpointIsLocal({ type: "none" }, undefined)).toBe(false);
  });
});

describe("createSpeechNetworkRule", () => {
  test("allows start_listening when both endpoints are local", async () => {
    expect((await decide(fakeManager(LOCAL_STT, LOCAL_TTS))).kind).toBe("allow");
  });

  test("requires approval when the STT endpoint is remote (mentions microphone)", async () => {
    const decision = await decide(fakeManager(REMOTE_STT, LOCAL_TTS));
    expect(decision.kind).toBe("require_approval");
    if (decision.kind === "require_approval") {
      expect(decision.dangerous).toBe(true);
      expect(decision.reason).toContain("microphone audio");
      expect(decision.reason).toContain("DGX Nemotron");
      expect(decision.reason).not.toContain("conversation text");
    }
  });

  test("requires approval when only the TTS endpoint is non-local", async () => {
    const decision = await decide(fakeManager(LOCAL_STT, CLOUD_TTS));
    expect(decision.kind).toBe("require_approval");
    if (decision.kind === "require_approval") {
      expect(decision.reason).toContain("conversation text");
      expect(decision.reason).not.toContain("microphone");
    }
  });

  test("names both targets when both endpoints are remote", async () => {
    const decision = await decide(fakeManager(REMOTE_STT, CLOUD_TTS));
    expect(decision.kind).toBe("require_approval");
    if (decision.kind === "require_approval") {
      expect(decision.reason).toContain("microphone audio");
      expect(decision.reason).toContain("conversation text");
    }
  });

  test("allows the hub's preApproved re-invoke", async () => {
    expect((await decide(fakeManager(REMOTE_STT, CLOUD_TTS), { preApproved: true })).kind).toBe(
      "allow",
    );
  });

  test("ignores other actions, paths, and non-session providers", async () => {
    const manager = fakeManager(REMOTE_STT, CLOUD_TTS);
    expect((await decide(manager, { action: "stop_listening" })).kind).toBe("allow");
    expect((await decide(manager, { path: "/other" })).kind).toBe("allow");
    expect((await decide(manager, { providerId: "some-provider" })).kind).toBe("allow");
  });

  test("unconfigured modalities do not require approval", async () => {
    expect((await decide(fakeManager(null, null))).kind).toBe("allow");
  });
});
