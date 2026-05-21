import { Text } from "@earendil-works/pi-tui";

import type { TranscriptMessage } from "../backend/slop-types";
import { assembleTranscript } from "../state/stream-assembler";

export class ChatLog extends Text {
  update(messages: TranscriptMessage[]): void {
    if (messages.length === 0) {
      this.setText("No transcript yet.");
      return;
    }
    this.setText(
      assembleTranscript(messages)
        .map((message) => {
          const label = message.role === "assistant" ? "assistant" : message.role;
          return `${label}> ${message.text || message.state}`;
        })
        .join("\n\n"),
    );
  }
}
