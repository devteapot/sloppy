import { TextAttributes } from "@opentui/core";
import { COLORS } from "../lib/theme";
import type { SessionViewSnapshot } from "../slop/types";

export function SettingsRoute(props: { snapshot: SessionViewSnapshot }) {
  return (
    <scrollbox flexGrow={1} padding={1} backgroundColor={COLORS.base}>
      <text fg={COLORS.green} attributes={TextAttributes.BOLD} content="Settings" />
      <text fg={COLORS.dim} content="Settings mirror public session state and profile commands." />
      <text
        fg={COLORS.text}
        content={`Session: ${props.snapshot.session.sessionId ?? "unknown"} · clients=${props.snapshot.session.clientCount ?? 0}`}
      />
      <text
        fg={COLORS.text}
        content={`Secure store: ${props.snapshot.llm.secureStoreKind ?? "unknown"} ${props.snapshot.llm.secureStoreStatus ?? ""}`}
      />
      <text fg={COLORS.dim} content="Theme: restrained dark terminal palette." />
      <text
        fg={COLORS.cyan}
        content="Profile commands: /default <id> · /delete-profile <id> · /delete-key <id>"
      />
    </scrollbox>
  );
}
