import type { HelloMessage, SlopConsumer } from "@slop-ai/consumer";

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

// SlopConsumer.connect() never settles if the peer accepts but withholds the
// hello, or closes before the hello arrives (the SDK only emits "disconnect").
// Race the handshake against both a timeout and the disconnect event, and tear
// the consumer down on failure so no half-open socket lingers. The abandoned
// SDK promise must never be awaited elsewhere.
export async function connectWithTimeout(
  consumer: SlopConsumer,
  timeoutMs: number,
  endpoint: string,
): Promise<HelloMessage> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failOnClose: (() => void) | undefined;
  try {
    return await new Promise<HelloMessage>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out connecting to ${endpoint} after ${timeoutMs}ms.`)),
        timeoutMs,
      );
      failOnClose = () =>
        reject(new Error(`Connection to ${endpoint} closed before handshake completed.`));
      consumer.on("disconnect", failOnClose);
      consumer.connect().then(resolve, reject);
    });
  } catch (error) {
    consumer.disconnect();
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (failOnClose) {
      consumer.off("disconnect", failOnClose);
    }
  }
}

export type ReconnectOptions = {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
};

// Bounded exponential backoff for re-running connect() after an unexpected
// disconnect. Defaults: 250ms doubling to a 4s cap, 6 attempts (~11.75s).
export class ReconnectScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number;

  constructor(options: ReconnectOptions = {}) {
    this.initialDelayMs = options.initialDelayMs ?? 250;
    this.maxDelayMs = options.maxDelayMs ?? 4_000;
    this.maxAttempts = options.maxAttempts ?? 6;
  }

  get attemptCount(): number {
    return this.attempts;
  }

  // Returns false when the attempt budget is exhausted.
  schedule(run: () => void): boolean {
    this.cancelTimer();
    if (this.attempts >= this.maxAttempts) {
      return false;
    }
    const delay = Math.min(this.initialDelayMs * 2 ** this.attempts, this.maxDelayMs);
    this.attempts += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      run();
    }, delay);
    // A pending retry must never keep the process alive on its own.
    this.timer.unref?.();
    return true;
  }

  reset(): void {
    this.cancelTimer();
    this.attempts = 0;
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
