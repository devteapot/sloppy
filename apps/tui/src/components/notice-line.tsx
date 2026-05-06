import { COLORS } from "../lib/theme";

export type Notice = {
  kind: "info" | "ok" | "warn" | "error";
  message: string;
  at?: string;
};

function colorFor(kind: Notice["kind"]): string {
  switch (kind) {
    case "ok":
      return COLORS.green;
    case "warn":
      return COLORS.yellow;
    case "error":
      return COLORS.red;
    default:
      return COLORS.cyan;
  }
}

export function NoticeLine(props: { notice: Notice; history?: Notice[]; expanded?: boolean }) {
  return (
    <box height={1} paddingX={1} backgroundColor={COLORS.panel}>
      <text fg={colorFor(props.notice.kind)} truncate content={props.notice.message} />
    </box>
  );
}
