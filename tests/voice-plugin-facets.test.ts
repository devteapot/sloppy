import { describe, expect, test } from "bun:test";

import {
  activeFirstPartyPlugins,
  FIRST_PARTY_PLUGINS,
  isFirstPartyPluginEnabled,
} from "../src/plugins/first-party/catalog";
import {
  createFirstPartyDoctorChecks,
  createFirstPartyDoctorSubprocessProbes,
} from "../src/plugins/first-party/doctor-facets";
import { createFirstPartySessionPlugins } from "../src/plugins/first-party/session-facets";
import {
  checkVoiceConfiguration,
  collectVoiceSubprocessProbes,
} from "../src/plugins/first-party/voice/doctor";
import type { RuntimeDoctorContext } from "../src/runtime/doctor-types";
import { createTestConfig } from "./helpers/config";

function voiceConfig() {
  return createTestConfig({
    plugins: {
      voice: {
        enabled: true,
        stt: {
          endpoints: {
            local: {
              protocol: "realtime-stt",
              dialect: "openai",
              baseUrl: "ws://localhost:8000/v1/realtime",
              auth: { type: "none" },
              sampleRate: 16000,
              models: {},
            },
          },
          profiles: [{ id: "local", endpointId: "local", model: "asr" }],
          defaultProfileId: "local",
        },
        conversation: {
          enabled: true,
          audio: {
            backend: "host",
            streamCommand: ["custom-capture", "{rate}"],
            playStreamCommand: ["custom-play", "{rate}"],
            streamChunkMs: 40,
            providerId: "reachy",
          },
          embodiment: { enabled: false, providerId: "reachy", emotes: false },
          realtime: { autoStartMode: "off", defaultStartMode: "single_turn" },
        },
      },
    },
  });
}

function doctorContext(config = voiceConfig()): RuntimeDoctorContext {
  return {
    config,
    workspaceRoot: "/tmp/sloppy-voice-doctor",
    timeoutMs: 100,
    options: {},
  };
}

describe("voice Plugin facets", () => {
  test("one voice Plugin owns its Provider, Session client contributions, and doctor facets", () => {
    const descriptors = FIRST_PARTY_PLUGINS.filter((plugin) => plugin.id === "voice");
    expect(descriptors.map((plugin) => plugin.id)).toEqual(["voice"]);

    const voice = descriptors[0];
    expect(voice?.createProviders).toBeFunction();
    const sessionPlugin = createFirstPartySessionPlugins(voiceConfig()).find(
      (plugin) => plugin.id === "voice",
    );
    expect(sessionPlugin?.client?.actions?.map((action) => action.id)).toEqual([
      "voice:listen-once",
      "voice:listen-continuous",
      "voice:stop",
    ]);
    expect(createFirstPartyDoctorChecks(voiceConfig())).toContain(checkVoiceConfiguration);
    expect(createFirstPartyDoctorSubprocessProbes(voiceConfig())).toContain(
      collectVoiceSubprocessProbes,
    );
  });

  test("conversation enablement activates the consolidated voice Plugin", () => {
    const config = createTestConfig({
      plugins: {
        voice: {
          enabled: false,
          conversation: {
            enabled: true,
            audio: { backend: "host", streamChunkMs: 40, providerId: "reachy" },
            embodiment: { enabled: false, providerId: "reachy", emotes: false },
            realtime: { autoStartMode: "off", defaultStartMode: "single_turn" },
          },
        },
      },
    });
    const voice = FIRST_PARTY_PLUGINS.find((plugin) => plugin.id === "voice");
    expect(voice).toBeDefined();
    expect(isFirstPartyPluginEnabled(config, voice!)).toBe(true);
    expect(activeFirstPartyPlugins(config).some((plugin) => plugin.id === "voice")).toBe(true);
    expect(
      createFirstPartySessionPlugins(config).filter((plugin) => plugin.id === "voice"),
    ).toHaveLength(1);
  });

  test("provider-only voice publishes no disabled conversation node or client actions", () => {
    const config = createTestConfig({ plugins: { voice: { enabled: true } } });
    const voice = createFirstPartySessionPlugins(config).find((plugin) => plugin.id === "voice");
    expect(voice).toBeDefined();
    expect(voice?.sessionNodes).toBeUndefined();
    expect(voice?.client).toBeUndefined();
  });

  test("doctor validates profile references and reports configured host commands", () => {
    expect(checkVoiceConfiguration(doctorContext())).toEqual({
      id: "voice-configuration",
      status: "ok",
      summary: "Voice profiles and conversation audio configuration are consistent.",
    });
    expect(collectVoiceSubprocessProbes(doctorContext())).toEqual([
      {
        label: "voice:microphone-capture",
        command: "custom-capture",
        cwd: "/tmp/sloppy-voice-doctor",
      },
      {
        label: "voice:speaker-playback",
        command: "custom-play",
        cwd: "/tmp/sloppy-voice-doctor",
      },
    ]);

    const invalid = voiceConfig();
    invalid.plugins.voice.stt.profiles[0] = {
      id: "local",
      endpointId: "missing",
      model: "asr",
    };
    const result = checkVoiceConfiguration(doctorContext(invalid));
    expect(result.status).toBe("error");
    expect(result.detail).toContain("unknown endpoint 'missing'");
  });
});
