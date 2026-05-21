import { Editor, type TUI } from "@earendil-works/pi-tui";

import { editorTheme } from "./theme";

export class CustomEditor extends Editor {
  constructor(tui: TUI) {
    super(tui, editorTheme, { paddingX: 1 });
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
}
