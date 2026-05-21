import type { TranscriptMessage } from "../backend/slop-types";

export type ThinkingRenderMode = "default" | "expanded" | "collapsed";

export type RenderableMessage = {
  id: string;
  seq: number;
  role: TranscriptMessage["role"];
  text: string;
  state: string;
};

export function assembleTranscript(
  messages: TranscriptMessage[],
  options?: { thinking?: ThinkingRenderMode },
): RenderableMessage[] {
  return messages.map((message) => ({
    id: message.id,
    seq: message.seq,
    role: message.role,
    state: message.state,
    text: message.blocks
      .map((block) => renderBlock(block, options?.thinking ?? "default"))
      .filter(Boolean)
      .join("\n"),
  }));
}

function renderBlock(
  block: TranscriptMessage["blocks"][number],
  thinkingMode: ThinkingRenderMode,
): string {
  if (block.type !== "thinking") {
    return block.text ?? block.preview ?? block.summary ?? "";
  }

  const expanded =
    thinkingMode === "expanded" || (thinkingMode === "default" && block.display !== "hidden");
  const details = [
    block.format === "summary" ? "summary" : "raw",
    block.elapsedMs === undefined ? undefined : formatDuration(block.elapsedMs),
    block.tokenCount === undefined || block.tokenCountSource !== "reported"
      ? undefined
      : `${block.tokenCount} tokens`,
  ]
    .filter(Boolean)
    .join(" · ");
  const label = `thinking${details ? ` · ${details}` : ""}`;
  if (!expanded) {
    return `[${label}]`;
  }
  return [`[${label}]`, block.text].filter(Boolean).join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}
