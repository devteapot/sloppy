import { Editor, type TUI } from "@earendil-works/pi-tui";

import { editorTheme } from "./theme";

export class CustomEditor extends Editor {
  constructor(tui: TUI) {
    super(tui, editorTheme, { paddingX: 1 });
  }
}
