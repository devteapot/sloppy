import { SyntaxStyle } from "@opentui/core";

const NO_COLOR = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "";

// Tonal palette inspired by docs/ui-design-system.md (the "Nocturnal Observer").
// Surface levels go darker→lighter for stacked depth. NO_COLOR collapses all
// hues to grayscale; emphasis is then carried by TextAttributes.BOLD/UNDERLINE.
const COLOR_PALETTE = {
  surface: "#111319",
  surfaceLow: "#15181f",
  surface2: "#1a1e27",
  surfaceHigh: "#252a36",

  text: "#d7dce7",
  textMuted: "#a6aebd",
  dim: "#88919f",

  cyan: "#6bd6ff",
  green: "#91db37",
  red: "#ff6b7a",
  yellow: "#f6c15b",

  ghostBorder: "#3a4150",
};

const NEUTRAL_PALETTE = {
  surface: "#0b0c0f",
  surfaceLow: "#101216",
  surface2: "#15171c",
  surfaceHigh: "#1f2228",

  text: "#e8e8e8",
  textMuted: "#bababa",
  dim: "#7a7a7a",

  cyan: "#e8e8e8",
  green: "#e8e8e8",
  red: "#e8e8e8",
  yellow: "#e8e8e8",

  ghostBorder: "#3a3a3a",
};

const ACTIVE = NO_COLOR ? NEUTRAL_PALETTE : COLOR_PALETTE;

// Backwards-compatible aliases used throughout the existing components.
export const COLORS = {
  base: ACTIVE.surface,
  panel: ACTIVE.surface2,
  panelHigh: ACTIVE.surfaceHigh,
  panelLow: ACTIVE.surfaceLow,
  text: ACTIVE.text,
  textMuted: ACTIVE.textMuted,
  dim: ACTIVE.dim,
  cyan: ACTIVE.cyan,
  green: ACTIVE.green,
  red: ACTIVE.red,
  yellow: ACTIVE.yellow,
  ghostBorder: ACTIVE.ghostBorder,
};

export const NO_COLOR_MODE = NO_COLOR;

export const MARKDOWN_STYLE = SyntaxStyle.fromStyles({
  heading: { fg: COLORS.green, bold: true },
  strong: { bold: true },
  emphasis: { italic: true },
  code: { fg: COLORS.cyan },
  link: { fg: COLORS.cyan, underline: true },
});

export function label(text: string): string {
  // Uppercase with hair-spacing for the "blueprint" label feel called out in
  // docs/ui-design-system.md. Renders consistently in monospace terminals.
  return Array.from(text.toUpperCase()).join(" ");
}
