import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

const plain = (value: string): string => value;
const sgr =
  (open: string, close: string) =>
  (value: string): string =>
    value.length === 0 ? value : `\x1b[${open}m${value}\x1b[${close}m`;

export const bold = sgr("1", "22");
export const dim = sgr("2", "22");
const italic = sgr("3", "23");
const underline = sgr("4", "24");
const strikethrough = sgr("9", "29");
export const accent = sgr("36", "39");
export const green = sgr("32", "39");
export const orange = sgr("38;5;214", "39");
export const redOrange = sgr("38;5;202", "39");
export const red = sgr("31", "39");
export const teal = sgr("38;5;43", "39");
export const bgAdd = sgr("48;5;22", "49");
export const bgRemove = sgr("48;5;52", "49");
export const userMessageOverlay = sgr("48;5;237", "49");

export const selectListTheme: SelectListTheme = {
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

export const markdownTheme: MarkdownTheme = {
  heading: (value) => accent(bold(value)),
  link: underline,
  linkUrl: dim,
  code: dim,
  codeBlock: dim,
  codeBlockBorder: dim,
  quote: dim,
  quoteBorder: dim,
  hr: dim,
  listBullet: dim,
  bold,
  italic,
  strikethrough,
  underline,
};
