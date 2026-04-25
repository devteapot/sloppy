// Pure, side-effect-free helpers used by the run loop to render tool-result
// payloads. Kept separate from the turn-driver so the loop file can be the
// model-call → append → iterate driver without inline serialization noise.

export function stringifyResult(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

export function toolErrorCode(error: unknown): string | undefined {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown };
    return typeof candidate.code === "string" ? candidate.code : undefined;
  }
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown };
    return typeof candidate.code === "string" ? candidate.code : undefined;
  }
  return undefined;
}

export function truncateToolResult(result: unknown, maxSize: number): string {
  const content = stringifyResult(result);
  const contentLength = content.length;

  if (contentLength <= maxSize) {
    return content;
  }

  const truncationMessage =
    "[truncated: $removed chars removed, use slop_query_state for full details]";
  const reservedForMessage = 100;
  const keep = maxSize - reservedForMessage;

  return (
    content.slice(0, keep) + truncationMessage.replace("$removed", String(contentLength - keep))
  );
}
