import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function formatCompact(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

// Clips overlong lines before padding so a single padded row can never exceed
// the target width.
export function padToWidth(line: string, width: number): string {
  const clipped = visibleWidth(line) > width ? truncateToWidth(line, width, "", true) : line;
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}
