import type {
  RuntimeDoctorCheck,
  RuntimeDoctorContext,
  RuntimeDoctorSubprocessProbe,
} from "../../../runtime/doctor-types";
import { DEFAULT_STT_ENDPOINTS, DEFAULT_TTS_ENDPOINTS } from "./endpoints";

function voiceEnabled(config: RuntimeDoctorContext["config"]): boolean {
  return config.plugins.voice.enabled || config.plugins.voice.conversation.enabled;
}

export function checkVoiceConfiguration({ config }: RuntimeDoctorContext): RuntimeDoctorCheck {
  if (!voiceEnabled(config)) {
    return {
      id: "voice-configuration",
      status: "skipped",
      summary: "Voice plugin disabled.",
    };
  }

  const speech = config.plugins.voice;
  const conversation = config.plugins.voice.conversation;
  const problems: string[] = [];
  const sttEndpoints = { ...DEFAULT_STT_ENDPOINTS, ...speech.stt.endpoints };
  const ttsEndpoints = { ...DEFAULT_TTS_ENDPOINTS, ...speech.tts.endpoints };

  const sttProfiles = new Set(speech.stt.profiles.map((profile) => profile.id));
  const ttsProfiles = new Set(speech.tts.profiles.map((profile) => profile.id));
  for (const profile of speech.stt.profiles) {
    const endpoint = sttEndpoints[profile.endpointId];
    if (!endpoint) {
      problems.push(
        `STT profile '${profile.id}' references unknown endpoint '${profile.endpointId}'.`,
      );
    } else if (conversation.enabled && !validSpeechUrl(endpoint.baseUrl)) {
      problems.push(
        `STT endpoint '${profile.endpointId}' needs an explicit HTTP(S) or WS(S) baseUrl for immutable voice-run consent.`,
      );
    }
  }
  for (const profile of speech.tts.profiles) {
    const endpoint = ttsEndpoints[profile.endpointId];
    if (!endpoint) {
      problems.push(
        `TTS profile '${profile.id}' references unknown endpoint '${profile.endpointId}'.`,
      );
    } else if (conversation.enabled && !validSpeechUrl(endpoint.baseUrl)) {
      problems.push(
        `TTS endpoint '${profile.endpointId}' needs an explicit HTTP(S) or WS(S) baseUrl for immutable voice-run consent.`,
      );
    }
  }
  if (speech.stt.defaultProfileId && !sttProfiles.has(speech.stt.defaultProfileId)) {
    problems.push(`Default STT profile '${speech.stt.defaultProfileId}' is not configured.`);
  }
  if (speech.tts.defaultProfileId && !ttsProfiles.has(speech.tts.defaultProfileId)) {
    problems.push(`Default TTS profile '${speech.tts.defaultProfileId}' is not configured.`);
  }
  if (conversation.enabled && speech.stt.profiles.length === 0) {
    problems.push("Voice conversation requires at least one STT profile.");
  }
  if (conversation.enabled && conversation.audio.backend === "robot") {
    problems.push(
      "The robot audio backend does not yet expose a streaming microphone input; use the host backend for realtime conversation.",
    );
  }

  if (problems.length > 0) {
    return {
      id: "voice-configuration",
      status: "error",
      summary: `${problems.length} voice configuration problem(s) found.`,
      detail: problems.join("\n"),
    };
  }

  return {
    id: "voice-configuration",
    status: "ok",
    summary: conversation.enabled
      ? "Voice profiles and conversation audio configuration are consistent."
      : "Voice speech profiles are consistent; conversation is disabled.",
  };
}

function validSpeechUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return ["http:", "https:", "ws:", "wss:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function collectVoiceSubprocessProbes({
  config,
  workspaceRoot,
}: RuntimeDoctorContext): RuntimeDoctorSubprocessProbe[] {
  const conversation = config.plugins.voice.conversation;
  if (!voiceEnabled(config) || !conversation.enabled || conversation.audio.backend !== "host") {
    return [];
  }

  return [
    {
      label: "voice:microphone-capture",
      command: conversation.audio.streamCommand?.[0] ?? "sox",
      cwd: workspaceRoot,
    },
    {
      label: "voice:speaker-playback",
      command: conversation.audio.playStreamCommand?.[0] ?? "play",
      cwd: workspaceRoot,
    },
  ];
}
