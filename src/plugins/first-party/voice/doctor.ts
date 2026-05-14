import type {
  RuntimeDoctorCheck,
  RuntimeDoctorContext,
  RuntimeDoctorSubprocessProbe,
} from "../../../runtime/doctor-types";

export function checkVoiceAdapters(context: RuntimeDoctorContext): RuntimeDoctorCheck {
  const voice = context.config.plugins.voice;
  if (!voice.enabled) {
    return {
      id: "voice-adapters",
      status: "skipped",
      summary: "Voice plugin is disabled.",
    };
  }

  const issues: string[] = [];
  const selectedInput = voice.adapters[voice.input.adapterId];
  const selectedOutput = voice.adapters[voice.output.adapterId];

  if (!selectedInput) {
    issues.push(`Selected STT adapter '${voice.input.adapterId}' is not configured.`);
  }
  if (!selectedOutput) {
    issues.push(`Selected TTS adapter '${voice.output.adapterId}' is not configured.`);
  }

  for (const [id, adapter] of Object.entries(voice.adapters)) {
    if (
      (adapter.kind === "openai-transcribe" || adapter.kind === "openai-tts") &&
      !Bun.env[adapter.apiKeyEnv]
    ) {
      issues.push(`Voice adapter '${id}' requires ${adapter.apiKeyEnv}, but it is not set.`);
    }
  }

  if (issues.length > 0) {
    return {
      id: "voice-adapters",
      status: "warning",
      summary: `${issues.length} voice adapter issue(s) found.`,
      detail: issues.join("\n"),
    };
  }

  return {
    id: "voice-adapters",
    status: "ok",
    summary: `Voice plugin is ready with STT '${voice.input.adapterId}' and TTS '${voice.output.adapterId}'.`,
  };
}

export function collectVoiceSubprocessProbes(
  context: RuntimeDoctorContext,
): RuntimeDoctorSubprocessProbe[] {
  const voice = context.config.plugins.voice;
  if (!voice.enabled) {
    return [];
  }

  return Object.entries(voice.adapters)
    .filter(
      (entry) => entry[1].kind === "local-stt-command" || entry[1].kind === "local-tts-command",
    )
    .map(([id, adapter]) => ({
      label: `voice:${id}`,
      command:
        adapter.kind === "local-stt-command" || adapter.kind === "local-tts-command"
          ? (adapter.command[0] ?? "")
          : "",
      cwd: context.workspaceRoot,
    }));
}
