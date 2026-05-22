import type { TranscriptMessage } from "../backend/slop-types";

export type ThinkingRenderMode = "default" | "expanded" | "collapsed";

export type RenderableTextBlock = {
  id: string;
  text: string;
  type: "text";
};

export type RenderableThinkingBlock = {
  expanded: boolean;
  id: string;
  label: string;
  text: string;
  type: "thinking";
};

export type RenderablePlainBlock = {
  id: string;
  text: string;
  type: "plain";
};

export type RenderableBlock = RenderableTextBlock | RenderableThinkingBlock | RenderablePlainBlock;

export type RenderableMessage = {
  blocks: RenderableBlock[];
  id: string;
  role: TranscriptMessage["role"];
  seq: number;
  state: string;
};

export function assembleTranscript(
  messages: TranscriptMessage[],
  options?: { thinking?: ThinkingRenderMode },
): RenderableMessage[] {
  return messages.map((message) => ({
    blocks: message.blocks
      .map((block) => renderBlock(block, options?.thinking ?? "default"))
      .filter((block) => block.text.length > 0 || block.type === "thinking"),
    id: message.id,
    seq: message.seq,
    role: message.role,
    state: message.state,
  }));
}

function renderBlock(
  block: TranscriptMessage["blocks"][number],
  thinkingMode: ThinkingRenderMode,
): RenderableBlock {
  if (block.type !== "thinking") {
    const text = block.text ?? block.preview ?? block.summary ?? "";
    return {
      id: block.id,
      text,
      type: block.type === "text" ? "text" : "plain",
    };
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
  return {
    expanded,
    id: block.id,
    label,
    text: expanded ? (block.text ?? "") : "",
    type: "thinking",
  };
}

export function renderableBlockText(block: RenderableBlock): string {
  if (block.type === "thinking") {
    return [`[${block.label}]`, block.expanded ? block.text : undefined].filter(Boolean).join("\n");
  }
  return block.text;
}

export function renderableMessageText(message: RenderableMessage): string {
  return message.blocks.map(renderableBlockText).filter(Boolean).join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}
