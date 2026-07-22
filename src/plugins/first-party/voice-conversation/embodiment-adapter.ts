import type { ResultMessage, SlopNode } from "@slop-ai/consumer/browser";

export type EmbodimentEmoteResult = "played" | "busy" | "unsupported";

export interface SpeakingEmbodiment {
  emote(name: string): Promise<EmbodimentEmoteResult>;
  finish(): Promise<void>;
}

/** Semantic embodiment seam; provider paths and robot choreography stay behind it. */
export interface EmbodimentAdapter {
  emoteNames(): Promise<readonly string[] | null>;
  beginSpeaking(signal?: AbortSignal): Promise<SpeakingEmbodiment>;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}

export class NullEmbodimentAdapter implements EmbodimentAdapter {
  async emoteNames(): Promise<readonly string[]> {
    return [];
  }

  async beginSpeaking(): Promise<SpeakingEmbodiment> {
    return NULL_SPEAKING_EMBODIMENT;
  }

  async interrupt(): Promise<void> {}

  async dispose(): Promise<void> {}
}

export type InvokeProvider = (
  providerId: string,
  path: string,
  action: string,
  params?: Record<string, unknown>,
) => Promise<ResultMessage>;

export type QueryProvider = (
  providerId: string,
  path: string,
  options?: { depth?: number },
) => Promise<SlopNode>;

export type ReachyEmbodimentOptions = {
  providerId: string;
  invoke: InvokeProvider;
  query: QueryProvider;
  animationIntervalMs?: number;
  delayFn?: (ms: number, signal: AbortSignal) => Promise<void>;
  nowMs?: () => number;
  onError?: (where: "emotes" | "animation" | "emote" | "stop", error: unknown) => void;
};

const HEAD_PITCH_DEG = 6;
const HEAD_YAW_DEG = 10;
const ANTENNA_RAD = 0.25;

/** Reachy adapter owning all `/behavior` and `/head` protocol knowledge. */
export class ReachyEmbodimentAdapter implements EmbodimentAdapter {
  private readonly providerId: string;
  private readonly invoke: InvokeProvider;
  private readonly query: QueryProvider;
  private readonly animationIntervalMs: number;
  private readonly delayFn: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly nowMs: () => number;
  private readonly onError?: ReachyEmbodimentOptions["onError"];
  private readonly active = new Set<ReachySpeakingEmbodiment>();
  private disposed = false;

  constructor(options: ReachyEmbodimentOptions) {
    this.providerId = options.providerId;
    this.invoke = options.invoke;
    this.query = options.query;
    this.animationIntervalMs = options.animationIntervalMs ?? 100;
    this.delayFn = options.delayFn ?? abortableDelay;
    this.nowMs = options.nowMs ?? Date.now;
    this.onError = options.onError;
  }

  async emoteNames(): Promise<readonly string[] | null> {
    try {
      const node = await this.query(this.providerId, "/behavior", { depth: 1 });
      const names = node.properties?.emotions;
      return Array.isArray(names)
        ? names.filter((name): name is string => typeof name === "string")
        : null;
    } catch (error) {
      this.onError?.("emotes", error);
      return null;
    }
  }

  async beginSpeaking(signal?: AbortSignal): Promise<SpeakingEmbodiment> {
    if (this.disposed) {
      throw new Error("Reachy embodiment adapter is disposed.");
    }
    const speaking = new ReachySpeakingEmbodiment({
      providerId: this.providerId,
      invoke: this.invoke,
      animationIntervalMs: this.animationIntervalMs,
      delayFn: this.delayFn,
      nowMs: this.nowMs,
      externalSignal: signal,
      onError: this.onError,
      onFinished: () => this.active.delete(speaking),
    });
    this.active.add(speaking);
    speaking.start();
    return speaking;
  }

  async interrupt(): Promise<void> {
    const active = [...this.active];
    await Promise.all(active.map((speaking) => speaking.finish()));
    try {
      await this.invoke(this.providerId, "/behavior", "stop");
    } catch (error) {
      this.onError?.("stop", error);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.interrupt();
  }
}

class ReachySpeakingEmbodiment implements SpeakingEmbodiment {
  private readonly controller = new AbortController();
  private readonly startedAt: number;
  private animation: Promise<void> = Promise.resolve();
  private finished = false;
  private removeExternalAbort?: () => void;

  constructor(
    private readonly options: {
      providerId: string;
      invoke: InvokeProvider;
      animationIntervalMs: number;
      delayFn: (ms: number, signal: AbortSignal) => Promise<void>;
      nowMs: () => number;
      externalSignal?: AbortSignal;
      onError?: ReachyEmbodimentOptions["onError"];
      onFinished: () => void;
    },
  ) {
    this.startedAt = options.nowMs();
    if (options.externalSignal) {
      const abort = () => this.controller.abort();
      options.externalSignal.addEventListener("abort", abort, { once: true });
      this.removeExternalAbort = () => options.externalSignal?.removeEventListener("abort", abort);
      if (options.externalSignal.aborted) this.controller.abort();
    }
  }

  start(): void {
    this.animation = this.animate();
  }

  async emote(name: string): Promise<EmbodimentEmoteResult> {
    if (this.finished || this.controller.signal.aborted) return "unsupported";
    try {
      const result = await this.options.invoke(
        this.options.providerId,
        "/behavior",
        "play_emotion",
        { name, sound: false },
      );
      if (result.status !== "error") return "played";
      return result.error?.code === "conflict" ? "busy" : "unsupported";
    } catch (error) {
      this.options.onError?.("emote", error);
      return "unsupported";
    }
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.controller.abort();
    this.removeExternalAbort?.();
    await this.animation;
    this.options.onFinished();
  }

  private async animate(): Promise<void> {
    while (!this.controller.signal.aborted) {
      const elapsedSeconds = (this.options.nowMs() - this.startedAt) / 1000;
      try {
        const pose = await this.options.invoke(this.options.providerId, "/head", "set_pose", {
          pitch: HEAD_PITCH_DEG * Math.sin(elapsedSeconds * 6),
          roll: 0,
          yaw: HEAD_YAW_DEG * Math.sin(elapsedSeconds * 2.3),
          z: 0,
        });
        if (pose.status !== "error" && !this.controller.signal.aborted) {
          await this.options.invoke(this.options.providerId, "/head", "set_antennas", {
            right: ANTENNA_RAD * Math.sin(elapsedSeconds * 7),
            left: ANTENNA_RAD * Math.sin(elapsedSeconds * 7 + Math.PI / 2),
          });
        }
      } catch (error) {
        this.options.onError?.("animation", error);
        return;
      }
      await this.options.delayFn(this.options.animationIntervalMs, this.controller.signal);
    }
  }
}

const NULL_SPEAKING_EMBODIMENT: SpeakingEmbodiment = {
  async emote() {
    return "unsupported";
  },
  async finish() {},
};

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay) => {
    if (signal.aborted) {
      resolveDelay();
      return;
    }
    const timer = setTimeout(resolveDelay, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolveDelay();
      },
      { once: true },
    );
  });
}
