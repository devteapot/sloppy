import { MAX_LLM_REQUEST_TIMER_MS } from "../config/schema";
import {
  isLlmAbortError,
  LlmAbortError,
  type LlmAdapter,
  type LlmChatOptions,
  LlmRequestError,
  type LlmRequestErrorCode,
  type LlmResponse,
  normalizeLlmAbortError,
} from "./types";

export interface LlmRequestPolicy {
  timeoutMs: number;
  maxRetries: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
}

function validateIntegerRange(
  policy: Record<string, unknown>,
  field: keyof LlmRequestPolicy,
  minimum: number,
  maximum?: number,
): string | undefined {
  const value = policy[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return `${field} must be a safe integer.`;
  }
  if (value < minimum) {
    return `${field} must be greater than or equal to ${minimum}.`;
  }
  if (maximum !== undefined && value > maximum) {
    return `${field} must be less than or equal to ${maximum}.`;
  }
  return undefined;
}

export function validateLlmRequestPolicy(policy: unknown): string | undefined {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return "request policy must be an object.";
  }

  const record = policy as Record<string, unknown>;
  const fieldError =
    validateIntegerRange(record, "timeoutMs", 1000, MAX_LLM_REQUEST_TIMER_MS) ??
    validateIntegerRange(record, "maxRetries", 0, 10) ??
    validateIntegerRange(record, "baseRetryDelayMs", 0, MAX_LLM_REQUEST_TIMER_MS) ??
    validateIntegerRange(record, "maxRetryDelayMs", 0, MAX_LLM_REQUEST_TIMER_MS);
  if (fieldError) {
    return fieldError;
  }

  if ((record.maxRetryDelayMs as number) < (record.baseRetryDelayMs as number)) {
    return "maxRetryDelayMs must be greater than or equal to baseRetryDelayMs.";
  }
  return undefined;
}

interface LlmResilienceDependencies {
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

type ErrorRecord = Record<string, unknown>;

function asRecord(value: unknown): ErrorRecord | undefined {
  return typeof value === "object" && value !== null ? (value as ErrorRecord) : undefined;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const record = asRecord(headers);
  if (!record) {
    return undefined;
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === target && (typeof value === "string" || typeof value === "number")) {
      return String(value);
    }
  }
  return undefined;
}

function errorHeaders(record: ErrorRecord | undefined): unknown {
  return record?.headers ?? asRecord(record?.response)?.headers;
}

function errorStatus(record: ErrorRecord | undefined): number | undefined {
  return numericValue(record?.status) ?? numericValue(asRecord(record?.response)?.status);
}

function retryAfterMs(headers: unknown, now: () => number): number | undefined {
  const explicitMilliseconds = numericValue(headerValue(headers, "retry-after-ms"));
  if (explicitMilliseconds !== undefined) {
    return Math.max(0, explicitMilliseconds);
  }

  const retryAfter = headerValue(headers, "retry-after");
  if (!retryAfter) {
    return undefined;
  }
  const seconds = numericValue(retryAfter);
  if (seconds !== undefined) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now());
}

function requestId(record: ErrorRecord | undefined, headers: unknown): string | undefined {
  const direct = record?.requestId ?? record?.request_id;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  return (
    headerValue(headers, "request-id") ??
    headerValue(headers, "x-request-id") ??
    headerValue(headers, "cf-ray")
  );
}

function providerCode(record: ErrorRecord | undefined): string | undefined {
  const nested = asRecord(record?.error);
  const value = record?.code ?? nested?.code ?? nested?.type;
  return typeof value === "string" ? value : undefined;
}

function classifyError(
  status: number | undefined,
  code: string | undefined,
  message: string,
): { code: LlmRequestErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) {
    return { code: "authentication", retryable: false };
  }
  if (status === 429) {
    return { code: "rate_limit", retryable: true };
  }
  if (status === 408 || status === 409 || status === 425) {
    return { code: "network", retryable: true };
  }
  if (status !== undefined && status >= 500) {
    return { code: status === 503 || status === 529 ? "overloaded" : "provider", retryable: true };
  }
  if (status !== undefined && status >= 400) {
    return { code: "invalid_request", retryable: false };
  }

  const candidate = `${code ?? ""} ${message}`.toLowerCase();
  if (/rate.?limit|too many requests|quota.*temporar/.test(candidate)) {
    return { code: "rate_limit", retryable: true };
  }
  if (/unauthori[sz]ed|forbidden|invalid.*api.?key|authentication/.test(candidate)) {
    return { code: "authentication", retryable: false };
  }
  if (/overload|capacity|service unavailable/.test(candidate)) {
    return { code: "overloaded", retryable: true };
  }
  if (/server_error|internal_error|temporar(?:y|ily)|internal server error/.test(candidate)) {
    return { code: "provider", retryable: true };
  }
  if (/timeout|timed out/.test(candidate)) {
    return { code: "timeout", retryable: true };
  }
  if (
    /econn|enotfound|eai_again|fetch failed|network|socket|connection|incomplete_stream|premature.*close/.test(
      candidate,
    )
  ) {
    return { code: "network", retryable: true };
  }
  if (/invalid|bad request|unprocessable|not found/.test(candidate)) {
    return { code: "invalid_request", retryable: false };
  }
  return { code: "provider", retryable: false };
}

export function normalizeLlmRequestError(
  error: unknown,
  options: {
    partialOutput?: boolean;
    timedOut?: boolean;
    now?: () => number;
  } = {},
): LlmRequestError | LlmAbortError {
  if (isLlmAbortError(error) && !options.timedOut) {
    return error;
  }
  if (error instanceof LlmRequestError) {
    if (options.partialOutput && !error.partialOutput) {
      return new LlmRequestError(error.message, {
        code: error.code,
        retryable: error.retryable,
        status: error.status,
        retryAfterMs: error.retryAfterMs,
        requestId: error.requestId,
        partialOutput: true,
        cause: error,
      });
    }
    return error;
  }
  if (options.timedOut) {
    return new LlmRequestError("Model request timed out.", {
      code: "timeout",
      retryable: true,
      partialOutput: options.partialOutput,
      cause: error,
    });
  }

  const record = asRecord(error);
  const headers = errorHeaders(record);
  const status = errorStatus(record);
  const rawCode = providerCode(record);
  const message = error instanceof Error ? error.message : String(error);
  const classification = classifyError(status, rawCode, message);
  return new LlmRequestError(message, {
    ...classification,
    status,
    retryAfterMs: retryAfterMs(headers, options.now ?? Date.now),
    requestId: requestId(record, headers),
    partialOutput: options.partialOutput,
    cause: error,
  });
}

function sleepWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmAbortError());
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new LlmAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class ResilientLlmAdapter implements LlmAdapter {
  readonly countTextTokens?: LlmAdapter["countTextTokens"];
  readonly runtimeDescriptor: LlmAdapter["runtimeDescriptor"];
  private readonly policy: Readonly<LlmRequestPolicy>;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly adapter: LlmAdapter,
    policy: LlmRequestPolicy,
    dependencies: LlmResilienceDependencies = {},
  ) {
    const invalidPolicyReason = validateLlmRequestPolicy(policy);
    if (invalidPolicyReason) {
      throw new Error(`Invalid LLM request policy: ${invalidPolicyReason}`);
    }

    this.policy = Object.freeze({ ...policy });
    this.runtimeDescriptor = adapter.runtimeDescriptor;
    this.sleep = dependencies.sleep ?? sleepWithAbort;
    this.now = dependencies.now ?? Date.now;
    const countTextTokens = adapter.countTextTokens?.bind(adapter);
    if (countTextTokens) {
      this.countTextTokens = async (text, options) => {
        if (options?.signal?.aborted) {
          throw new LlmAbortError();
        }

        let timedOut = false;
        const controller = new AbortController();
        let rejectParentAbort: (reason: LlmAbortError) => void = () => {};
        const parentAbortFailure = new Promise<never>((_resolve, reject) => {
          rejectParentAbort = reject;
        });
        const onParentAbort = () => {
          controller.abort();
          rejectParentAbort(new LlmAbortError());
        };
        options?.signal?.addEventListener("abort", onParentAbort, { once: true });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const timeoutFailure = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error("Model token-count deadline exceeded."));
          }, this.policy.timeoutMs);
        });

        try {
          return await Promise.race([
            countTextTokens(text, { signal: controller.signal }),
            timeoutFailure,
            parentAbortFailure,
          ]);
        } catch (error) {
          if (options?.signal?.aborted) {
            throw new LlmAbortError();
          }
          const abortError = normalizeLlmAbortError(
            error,
            timedOut ? undefined : controller.signal,
          );
          throw normalizeLlmRequestError(abortError, { timedOut, now: this.now });
        } finally {
          if (timeout) {
            clearTimeout(timeout);
          }
          options?.signal?.removeEventListener("abort", onParentAbort);
        }
      };
    }
  }

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    let attempt = 0;
    while (true) {
      if (options.signal?.aborted) {
        throw new LlmAbortError();
      }

      let emittedOutput = false;
      let timedOut = false;
      let active = true;
      const controller = new AbortController();
      let rejectParentAbort: (reason: LlmAbortError) => void = () => {};
      const parentAbortFailure = new Promise<never>((_resolve, reject) => {
        rejectParentAbort = reject;
      });
      const onParentAbort = () => {
        controller.abort();
        rejectParentAbort(new LlmAbortError());
      };
      options.signal?.addEventListener("abort", onParentAbort, { once: true });

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutFailure = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error("Model request deadline exceeded."));
        }, this.policy.timeoutMs);
      });
      const deactivateAttempt = (abort = false) => {
        active = false;
        if (abort) {
          controller.abort();
        }
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        options.signal?.removeEventListener("abort", onParentAbort);
      };

      try {
        const request = this.adapter.chat({
          ...options,
          signal: controller.signal,
          onText: options.onText
            ? (chunk) => {
                if (!active) {
                  return;
                }
                emittedOutput = true;
                options.onText?.(chunk);
              }
            : undefined,
          onThinking: options.onThinking
            ? (delta) => {
                if (!active) {
                  return;
                }
                emittedOutput = true;
                options.onThinking?.(delta);
              }
            : undefined,
        });
        return await Promise.race([request, timeoutFailure, parentAbortFailure]);
      } catch (error) {
        if (options.signal?.aborted) {
          throw new LlmAbortError();
        }
        const abortError = normalizeLlmAbortError(error, timedOut ? undefined : controller.signal);
        const normalized = normalizeLlmRequestError(abortError, {
          partialOutput: emittedOutput,
          timedOut,
          now: this.now,
        });
        // A rejected attempt may still have a provider stream producing late
        // callbacks. Quiesce it before waiting for retry backoff.
        deactivateAttempt(true);
        if (
          normalized instanceof LlmAbortError ||
          !normalized.retryable ||
          normalized.partialOutput ||
          attempt >= this.policy.maxRetries
        ) {
          throw normalized;
        }

        const exponentialDelay = this.policy.baseRetryDelayMs * 2 ** attempt;
        const delay = Math.min(
          normalized.retryAfterMs ?? exponentialDelay,
          this.policy.maxRetryDelayMs,
        );
        attempt += 1;
        await this.sleep(delay, options.signal);
      } finally {
        deactivateAttempt();
      }
    }
  }
}
