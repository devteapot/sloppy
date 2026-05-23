import {
  CURSOR_MARKER,
  Editor,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type { ApprovalMode } from "../backend/slop-types";
import type { SlashEntry } from "../state/slash-catalog";
import { ComposerAutocompleteProvider } from "./composer-autocomplete";
import { dim, editorTheme, green, orange, red, redOrange, teal } from "./theme";

type ComposerSigilKind = "default" | "slash" | "bang";

const SIDE_PADDING = 1;
const PROMPT_GUTTER_WIDTH = 3;
const PLACEHOLDER = "Type a prompt, / for commands, or ! for shell";
const ESC = "\x1b";
const BEL = "\x07";

export class CustomEditor extends Editor {
  private readonly composerAutocomplete = new ComposerAutocompleteProvider();
  private modeLabel = "default";
  private approvalMode: ApprovalMode = "normal";

  constructor(tui: TUI) {
    super(tui, editorTheme, { paddingX: 1 });
    this.setAutocompleteProvider(this.composerAutocomplete);
  }

  setSlashEntries(entries: SlashEntry[]): void {
    this.composerAutocomplete.setSlashEntries(entries);
  }

  setWorkspaceRoot(root: string | null | undefined): void {
    this.composerAutocomplete.setWorkspaceRoot(root);
  }

  clearSlashDraft(): boolean {
    if (!this.isSlashCommandDraft()) {
      return false;
    }
    this.setText("");
    this.tui.requestRender();
    return true;
  }

  setModeLabel(mode: string): void {
    const next = mode.trim() || "default";
    if (this.modeLabel === next) {
      return;
    }
    this.modeLabel = next;
    this.tui.requestRender();
  }

  setApprovalMode(mode: ApprovalMode): void {
    if (this.approvalMode === mode) {
      return;
    }
    this.approvalMode = mode;
    this.tui.requestRender();
  }

  override render(width: number): string[] {
    const outerWidth = Math.max(8, Math.floor(width));
    const innerWidth = outerWidth - 2;
    const editorWidth = Math.max(1, innerWidth - SIDE_PADDING * 2 - PROMPT_GUTTER_WIDTH);
    const rendered = splitEditorRender(super.render(editorWidth));
    const inputLines = rendered.inputLines.length > 0 ? rendered.inputLines : [""];

    const sigilKind = this.composerSigilKind();
    const hiddenSigil = composerSigilTrigger(sigilKind);
    const hideLeadingSigil =
      hiddenSigil !== null && this.getCursor().line === 0 && this.getCursor().col > 0;
    const lines = [this.renderTopBorder(outerWidth)];
    for (const [index, line] of inputLines.entries()) {
      const inputLine =
        this.getText().length === 0 && index === 0
          ? this.renderPlaceholder(editorWidth)
          : hideLeadingSigil && index === 0
            ? removeFirstVisibleSigil(line, hiddenSigil)
            : line;
      lines.push(
        this.renderBoxLine(
          this.renderInputLine(inputLine, editorWidth, index === 0, sigilKind),
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
    return text;
  }

  private renderTopBorder(width: number): string {
    const innerWidth = width - 2;
    const label = ` ${this.modeLabel} `;
    const style = this.modeFrameStyle();
    if (visibleWidth(label) >= innerWidth) {
      return style(`╭${"─".repeat(innerWidth)}╮`);
    }
    return style(`╭${"─".repeat(innerWidth - visibleWidth(label))}${label}╮`);
  }

  private renderBottomBorder(width: number): string {
    return this.modeFrameStyle()(`╰${"─".repeat(width - 2)}╯`);
  }

  private renderBoxLine(content: string, innerWidth: number): string {
    const style = this.modeFrameStyle();
    return `${style("│")}${padToWidth(content, innerWidth)}${style("│")}`;
  }

  private renderInputLine(
    line: string,
    editorWidth: number,
    firstLine: boolean,
    sigilKind: ComposerSigilKind,
  ): string {
    const gutter = firstLine ? this.renderPromptGutter(sigilKind) : " ".repeat(PROMPT_GUTTER_WIDTH);
    return `${" ".repeat(SIDE_PADDING)}${gutter}${padToWidth(line, editorWidth)}${" ".repeat(SIDE_PADDING)}`;
  }

  private renderPromptGutter(kind: ComposerSigilKind): string {
    if (kind === "slash") {
      return `${green("/")}  `;
    }
    const approval = this.approvalMode === "auto" ? redOrange("!") : dim("?");
    if (kind === "bang") {
      return `${approval}${red("!")} `;
    }
    return `${approval}${orange(">")} `;
  }

  private composerSigilKind(): ComposerSigilKind {
    const firstLine = this.getLines()[0] ?? "";
    if (firstLine.startsWith("/")) {
      return "slash";
    }
    if (firstLine.startsWith("!")) {
      return "bang";
    }
    return "default";
  }

  private isSlashCommandDraft(): boolean {
    return this.getLines()[0]?.startsWith("/") ?? false;
  }

  private renderPlaceholder(width: number): string {
    const cursor = "\x1b[7m \x1b[0m";
    return padToWidth(`${this.focused ? CURSOR_MARKER : ""}${cursor} ${dim(PLACEHOLDER)}`, width);
  }

  private modeFrameStyle(): (value: string) => string {
    if (this.modeLabel === "plan") {
      return teal;
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

function composerSigilTrigger(kind: ComposerSigilKind): "/" | "!" | null {
  if (kind === "slash") {
    return "/";
  }
  if (kind === "bang") {
    return "!";
  }
  return null;
}

function removeFirstVisibleSigil(line: string, sigil: "/" | "!"): string {
  let result = "";
  let index = 0;
  let removed = false;
  while (index < line.length) {
    const sequence = readEscapeSequence(line, index);
    if (sequence) {
      result += sequence;
      index += sequence.length;
      continue;
    }
    const char = line[index] ?? "";
    if (!removed && char === sigil) {
      removed = true;
      if (stripAnsi(result).trim().length === 0) {
        result = "";
      }
      index += 1;
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

function stripAnsi(value: string): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    const sequence = readEscapeSequence(value, index);
    if (sequence) {
      index += sequence.length;
      continue;
    }
    result += value[index] ?? "";
    index += 1;
  }
  return result;
}

function readEscapeSequence(value: string, start: number): string | null {
  if (value.startsWith(CURSOR_MARKER, start)) {
    return CURSOR_MARKER;
  }
  if (value[start] !== ESC) {
    return null;
  }
  const next = value[start + 1];
  if (next === "[") {
    let index = start + 2;
    while (index < value.length) {
      const code = value.charCodeAt(index);
      index += 1;
      if (code >= 0x40 && code <= 0x7e) {
        break;
      }
    }
    return value.slice(start, index);
  }
  if (next === "]") {
    let index = start + 2;
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
    return value.slice(start, index);
  }
  return null;
}
