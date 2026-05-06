import { TextAttributes } from "@opentui/core";
import { Show } from "solid-js";
import { COLORS, MARKDOWN_STYLE } from "../lib/theme";
import type { TranscriptMessage } from "../slop/types";

export function MessageRow(props: { message: TranscriptMessage }) {
  const roleColor = () =>
    props.message.role === "assistant"
      ? COLORS.green
      : props.message.role === "user"
        ? COLORS.cyan
        : COLORS.dim;
  const body = () =>
    props.message.blocks
      .map((block) => {
        if (block.type === "media") {
          return `[${block.mime ?? "media"}] ${
            block.name ?? block.uri ?? block.summary ?? block.preview ?? block.id
          }`;
        }
        return block.text ?? "";
      })
      .join("\n");

  return (
    <box flexDirection="column" marginBottom={1}>
      <text
        fg={roleColor()}
        attributes={TextAttributes.BOLD}
        content={`${props.message.role} ${props.message.state === "streaming" ? "▍" : ""}`}
      />
      <markdown
        content={body() || "(empty)"}
        syntaxStyle={MARKDOWN_STYLE}
        fg={COLORS.text}
        bg={COLORS.base}
      />
      <Show when={props.message.error}>
        <text fg={COLORS.red} content={props.message.error} />
      </Show>
    </box>
  );
}
