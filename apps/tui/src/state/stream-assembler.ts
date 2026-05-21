import type { TranscriptMessage } from "../backend/slop-types";

export type RenderableMessage = {
  id: string;
  role: TranscriptMessage["role"];
  text: string;
  state: string;
};

export function assembleTranscript(messages: TranscriptMessage[]): RenderableMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    state: message.state,
    text: message.blocks
      .map((block) => block.text ?? block.preview ?? block.summary ?? "")
      .filter(Boolean)
      .join("\n"),
  }));
}
