import { TextAttributes } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/solid";
import { createSignal } from "solid-js";
import { isPrintableSequence } from "../lib/format";
import { COLORS } from "../lib/theme";
import type { SaveProfileInput } from "../slop/types";

export type SecretProfileDraft = Omit<SaveProfileInput, "apiKey">;

export function SecretPrompt(props: {
  profile: SecretProfileDraft;
  onSubmit: (apiKey: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = createSignal("");

  useKeyboard((key) => {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      props.onCancel();
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      props.onSubmit(value());
      setValue("");
      return;
    }

    if (key.name === "backspace") {
      setValue((current) => current.slice(0, -1));
      return;
    }

    if (!key.ctrl && !key.meta && key.sequence && isPrintableSequence(key.sequence)) {
      setValue((current) => current + key.sequence);
    }
  });

  usePaste((event) => {
    const text = new TextDecoder().decode(event.bytes);
    const sanitized = text.replace(/[\r\n]+/g, "");
    if (sanitized.length > 0) {
      setValue((current) => current + sanitized);
    }
    event.preventDefault();
  });

  return (
    <box
      position="absolute"
      top="35%"
      left="18%"
      width="64%"
      height={7}
      flexDirection="column"
      padding={1}
      backgroundColor={COLORS.panelHigh}
      border
      borderColor={COLORS.ghostBorder}
      zIndex={10}
    >
      <text fg={COLORS.green} attributes={TextAttributes.BOLD} content="Save API key" />
      <text
        fg={COLORS.text}
        content={`${props.profile.provider}/${props.profile.model ?? "default model"}${props.profile.adapterId ? ` · adapter=${props.profile.adapterId}` : ""} · input is masked and sent directly to /llm.save_profile`}
      />
      <text
        fg={COLORS.cyan}
        content={`${"*".repeat(value().length)}${value().length === 0 ? "(empty)" : ""}`}
      />
      <text fg={COLORS.dim} content="Enter saves · Esc cancels" />
    </box>
  );
}
