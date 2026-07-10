import { createHash } from "node:crypto";

import type {
  PreparedSpeechDestination,
  SpeechProfileManager,
} from "../../../speech/profile-manager";
import type { SttProtocolAdapter, TtsProtocolAdapter } from "../../../speech/types";

export type VoiceRunMode = "single_turn" | "continuous";

export type VoiceRunDestination = Readonly<{
  modality: "stt" | "tts";
  profileId: string;
  endpointId: string;
  label: string;
  origin?: string;
  remote: boolean;
  routingFingerprint: string;
}>;

export type VoiceRunPlanView = Readonly<{
  id: string;
  fingerprint: string;
  mode: VoiceRunMode;
  stt: VoiceRunDestination;
  tts?: VoiceRunDestination;
  remoteEgress: readonly VoiceRunDestination[];
}>;

export type VoiceRunPrivacyDecision =
  | { kind: "local" }
  | {
      kind: "approval_required";
      reason: string;
      paramsPreview: string;
      dangerous: true;
    };

export interface VoiceRunExecution {
  readonly plan: VoiceRunPlanView;
  createSttAdapter(): Promise<SttProtocolAdapter>;
  createTtsAdapter(): Promise<TtsProtocolAdapter | null>;
}

export interface PreparedVoiceRun {
  readonly plan: VoiceRunPlanView;
  readonly privacy: VoiceRunPrivacyDecision;
  /** May be called once, and only locally or from the approval callback. */
  begin(): VoiceRunExecution;
}

export async function prepareVoiceRun(
  manager: SpeechProfileManager,
  mode: VoiceRunMode,
  options?: { signal?: AbortSignal },
): Promise<PreparedVoiceRun> {
  const prepared = await abortable(
    manager.prepareActiveAdapters({ signal: options?.signal }),
    options?.signal,
  );
  const stt = destinationView("stt", prepared.stt.destination);
  const tts = prepared.tts ? destinationView("tts", prepared.tts.destination) : undefined;
  const fingerprint = fingerprintOf({
    mode,
    generation: prepared.generation,
    stt: stt.routingFingerprint,
    tts: tts?.routingFingerprint,
  });
  const remoteEgress = [stt, tts].filter(
    (destination): destination is VoiceRunDestination => destination?.remote === true,
  );
  const plan: VoiceRunPlanView = Object.freeze({
    id: `voice-run-${crypto.randomUUID()}`,
    fingerprint,
    mode,
    stt,
    ...(tts && { tts }),
    remoteEgress: Object.freeze(remoteEgress),
  });
  let begun = false;

  return {
    plan,
    privacy: buildPrivacyDecision(plan),
    begin(): VoiceRunExecution {
      if (begun) {
        throw new Error(`Voice run '${plan.id}' has already begun.`);
      }
      begun = true;
      return {
        plan,
        createSttAdapter: () => Promise.resolve(prepared.stt.createAdapter()),
        createTtsAdapter: () =>
          prepared.tts ? Promise.resolve(prepared.tts.createAdapter()) : Promise.resolve(null),
      };
    },
  };
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Voice preparation cancelled.");
}

function destinationView(
  modality: "stt" | "tts",
  destination: PreparedSpeechDestination,
): VoiceRunDestination {
  return Object.freeze({ modality, ...destination });
}

function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function buildPrivacyDecision(plan: VoiceRunPlanView): VoiceRunPrivacyDecision {
  if (plan.remoteEgress.length === 0) {
    return { kind: "local" };
  }
  const descriptions = plan.remoteEgress.map((destination) =>
    destination.modality === "stt"
      ? `your microphone audio to ${destination.label}${originSuffix(destination)}`
      : `conversation text to ${destination.label}${originSuffix(destination)}`,
  );
  return {
    kind: "approval_required",
    reason: `Voice conversation streams ${descriptions.join(" and ")}.`,
    paramsPreview: JSON.stringify({
      mode: plan.mode,
      run_id: plan.id,
      run_fingerprint: plan.fingerprint,
      stt_endpoint: plan.stt.endpointId,
      stt_origin: plan.stt.origin,
      tts_endpoint: plan.tts?.endpointId,
      tts_origin: plan.tts?.origin,
    }),
    dangerous: true,
  };
}

function originSuffix(destination: VoiceRunDestination): string {
  return destination.origin ? ` (${destination.origin})` : "";
}
