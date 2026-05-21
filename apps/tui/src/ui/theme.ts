import type { EditorTheme, SelectListTheme } from "@earendil-works/pi-tui";

const plain = (value: string): string => value;

const selectListTheme: SelectListTheme = {
  selectedPrefix: plain,
  selectedText: plain,
  description: plain,
  scrollInfo: plain,
  noMatch: plain,
};

export const editorTheme: EditorTheme = {
  borderColor: plain,
  selectList: selectListTheme,
};
