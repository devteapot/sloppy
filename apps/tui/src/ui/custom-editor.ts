import {
  CURSOR_MARKER,
  Editor,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { dim, editorTheme, orange, redOrange, teal } from "./theme";

const SIDE_PADDING = 1;
const PROMPT_GUTTER_WIDTH = 2;
const PLACEHOLDER = "Type a prompt or / for commands";
const ESC = "\x1b";
const BEL = "\x07";

export class CustomEditor extends Editor {
  private modeLabel = "default";

  constructor(tui: TUI) {
    super(tui, editorTheme, { paddingX: 1 });
  }

  setModeLabel(mode: string): void {
    const next = mode.trim() || "default";
    if (this.modeLabel === next) {
      return;
    }
    this.modeLabel = next;
    this.tui.requestRender();
  }

  override render(width: number): string[] {
    const outerWidth = Math.max(8, Math.floor(width));
    const innerWidth = outerWidth - 2;
    const editorWidth = Math.max(1, innerWidth - SIDE_PADDING * 2 - PROMPT_GUTTER_WIDTH);
    const rendered = splitEditorRender(super.render(editorWidth));
    const inputLines = rendered.inputLines.length > 0 ? rendered.inputLines : [""];

    const lines = [this.renderTopBorder(outerWidth)];
    for (const [index, line] of inputLines.entries()) {
      lines.push(
        this.renderBoxLine(
          this.renderInputLine(
            this.getText().length === 0 && index === 0 ? this.renderPlaceholder(editorWidth) : line,
            editorWidth,
            index === 0,
          ),
          innerWidth,
        ),
      );
    }
    lines.push(this.renderBottomBorder(outerWidth));

    for (const line of rendered.extraLines) {
      lines.push(
        padToWidth(`${" ".repeat(SIDE_PADDING + PROMPT_GUTTER_WIDTH + 1)}${line}`, outerWidth),
      );
    }

    return lines;
  }

  prepareSubmission(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith("!")) {
      return `Run this shell command through the terminal provider: ${trimmed.slice(1).trim()}`;
    }
    if (trimmed.startsWith("@")) {
      return `Inspect this workspace path through the filesystem provider: ${trimmed.slice(1).trim()}`;
    }
    return text;
  }

  private renderTopBorder(width: number): string {
    const innerWidth = width - 2;
    const label = ` ${this.modeLabel} `;
    const style = this.modeFrameStyle();
    if (visibleWidth(label) >= innerWidth) {
      return style(`┌${"─".repeat(innerWidth)}┐`);
    }
    return style(`┌${"─".repeat(innerWidth - visibleWidth(label))}${label}┐`);
  }

  private renderBottomBorder(width: number): string {
    return this.modeFrameStyle()(`└${"─".repeat(width - 2)}┘`);
  }

  private renderBoxLine(content: string, innerWidth: number): string {
    const style = this.modeFrameStyle();
    return `${style("│")}${padToWidth(content, innerWidth)}${style("│")}`;
  }

  private renderInputLine(line: string, editorWidth: number, firstLine: boolean): string {
    const gutter = firstLine ? `${orange(">")} ` : "  ";
    return `${" ".repeat(SIDE_PADDING)}${gutter}${padToWidth(line, editorWidth)}${" ".repeat(SIDE_PADDING)}`;
  }

  private renderPlaceholder(width: number): string {
    const cursor = "\x1b[7m \x1b[0m";
    return padToWidth(`${this.focused ? CURSOR_MARKER : ""}${cursor} ${dim(PLACEHOLDER)}`, width);
  }

  private modeFrameStyle(): (value: string) => string {
    if (this.modeLabel === "plan") {
      return teal;
    }
    if (this.modeLabel === "auto-approve") {
      return redOrange;
    }
    return dim;
  }
}

function splitEditorRender(lines: string[]): { inputLines: string[]; extraLines: string[] } {
  const withoutTopBorder = lines.slice(1);
  const bottomIndex = withoutTopBorder.findIndex(isEditorBorderLine);
  if (bottomIndex === -1) {
    return { inputLines: withoutTopBorder, extraLines: [] };
  }
  return {
    inputLines: withoutTopBorder.slice(0, bottomIndex),
    extraLines: withoutTopBorder.slice(bottomIndex + 1),
  };
}

function isEditorBorderLine(line: string): boolean {
  const plain = stripAnsi(line).trimEnd();
  return /^─+$/.test(plain) || /^─── [↑↓] \d+ more ─*$/.test(plain);
}

function padToWidth(line: string, width: number): string {
  const clipped = visibleWidth(line) > width ? truncateToWidth(line, width, "", true) : line;
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function stripAnsi(value: string): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    if (value.startsWith(CURSOR_MARKER, index)) {
      index += CURSOR_MARKER.length;
      continue;
    }
    if (value[index] === ESC) {
      const next = value[index + 1];
      if (next === "[") {
        index += 2;
        while (index < value.length) {
          const code = value.charCodeAt(index);
          index += 1;
          if (code >= 0x40 && code <= 0x7e) {
            break;
          }
        }
        continue;
      }
      if (next === "]") {
        index += 2;
        while (index < value.length) {
          if (value[index] === BEL) {
            index += 1;
            break;
          }
          if (value[index] === ESC && value[index + 1] === "\\") {
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }
    }
    result += value[index] ?? "";
    index += 1;
  }
  return result;
}
