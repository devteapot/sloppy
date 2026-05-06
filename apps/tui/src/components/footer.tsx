import { COLORS } from "../lib/theme";

export function Footer(props: { mouseEnabled: boolean }) {
  return (
    <box height={1} paddingX={1} backgroundColor={COLORS.base}>
      <text
        fg={COLORS.dim}
        truncate
        content={`F1 help · F2 setup · F3 approvals · F4 tasks · F5 apps · F6 inspect · F7 mouse ${props.mouseEnabled ? "on" : "off"} · ctrl+c cancel/clear/exit · alt+enter newline`}
      />
    </box>
  );
}
