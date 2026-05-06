import { TextAttributes } from "@opentui/core";
import { For, Show } from "solid-js";
import { MessageRow } from "../components/transcript";
import { COLORS } from "../lib/theme";
import type { InspectorMode, SessionViewSnapshot, TuiRoute } from "../slop/types";

export function ChatRoute(props: {
  snapshot: SessionViewSnapshot;
  onRoute: (route: TuiRoute) => void;
  onInspector: (mode: InspectorMode) => void;
}) {
  return (
    <scrollbox
      flexGrow={1}
      stickyScroll
      stickyStart="bottom"
      paddingX={1}
      paddingY={1}
      backgroundColor={COLORS.base}
      scrollbarOptions={{ showArrows: false }}
    >
      <Show when={props.snapshot.transcript.length === 0}>
        <IntroPanel snapshot={props.snapshot} />
      </Show>
      <For each={props.snapshot.transcript}>{(message) => <MessageRow message={message} />}</For>
    </scrollbox>
  );
}

function IntroPanel(props: { snapshot: SessionViewSnapshot }) {
  return (
    <box flexDirection="column" gap={1}>
      <text fg={COLORS.green} attributes={TextAttributes.BOLD} content="Sloppy TUI" />
      <text
        fg={COLORS.text}
        wrapMode="word"
        content="This interface is attached to the public agent-session provider. State updates arrive as SLOP snapshots and patches; actions go back through contextual affordances."
      />
      <text
        fg={COLORS.dim}
        content="Routes: F2 setup · F3 approvals · F4 tasks · F5 apps · F6 inspect"
      />
      <Show when={props.snapshot.llm.status === "needs_credentials"}>
        <text
          fg={COLORS.yellow}
          content="LLM credentials are missing. Open setup with F2 or /setup."
        />
      </Show>
    </box>
  );
}
