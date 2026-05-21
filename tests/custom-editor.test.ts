import { describe, expect, test } from "bun:test";
import { type Terminal, TUI, visibleWidth } from "@earendil-works/pi-tui";

import { CustomEditor } from "../apps/tui/src/ui/custom-editor";

const ESC = "\x1b";
const BEL = "\x07";
const CURSOR_MARKER = "\x1b_pi:c\x07";

class TestTerminal implements Terminal {
  get columns(): number {
    return 80;
  }

  get rows(): number {
    return 24;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

function createEditor(): CustomEditor {
  const tui = new TUI(new TestTerminal());
  const editor = new CustomEditor(tui);
  tui.setFocus(editor);
  return editor;
}

function plain(value: string): string {
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

describe("CustomEditor", () => {
  test("renders a boxed composer with mode label and prompt gutter", () => {
    const editor = createEditor();
    const lines = editor.render(56);

    expect(lines).toHaveLength(3);
    expect(plain(lines[0] ?? "")).toContain(" default ");
    expect(plain(lines[1] ?? "")).toContain("> ");
    expect(plain(lines[1] ?? "")).toContain("Type a prompt or / for commands");
    expect(plain(lines[2] ?? "")).toMatch(/^└─+┘$/);
    expect(lines.every((line) => visibleWidth(line) === 56)).toBe(true);
  });

  test("renders typed text inside the composer without placeholder text", () => {
    const editor = createEditor();
    editor.setText("hello");

    const rendered = plain(editor.render(44).join("\n"));

    expect(rendered).toContain("hello");
    expect(rendered).not.toContain("Type a prompt");
  });

  test("updates the composer mode label", () => {
    const editor = createEditor();
    editor.setModeLabel("plan");

    expect(plain(editor.render(40)[0] ?? "")).toContain(" plan ");
  });

  test("colors the composer frame by mode", () => {
    const editor = createEditor();
    expect(editor.render(40)[0]).toContain("\x1b[2m");

    editor.setModeLabel("plan");
    const planLines = editor.render(40);
    expect(planLines[0]).toContain("\x1b[38;5;43m");
    expect(planLines[1]).toContain("\x1b[38;5;43m│");
    expect(planLines[2]).toContain("\x1b[38;5;43m");

    editor.setModeLabel("auto-approve");
    const autoApproveLines = editor.render(40);
    expect(autoApproveLines[0]).toContain("\x1b[38;5;202m");
    expect(autoApproveLines[1]).toContain("\x1b[38;5;202m│");
    expect(autoApproveLines[2]).toContain("\x1b[38;5;202m");
  });
});
