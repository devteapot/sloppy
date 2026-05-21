const ESC = "\\x1b";
const BEL = "\\x07";

const csiPattern = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const oscPattern = new RegExp(`${ESC}\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\)`, "g");
const unterminatedOscPattern = new RegExp(`${ESC}\\][^${BEL}${ESC}\\n]*(?=\\n|$)`, "g");
const stringControlPattern = new RegExp(`${ESC}[PX^_][\\s\\S]*?(?:${BEL}|${ESC}\\\\)`, "g");
const unterminatedStringControlPattern = new RegExp(
  `${ESC}[PX^_][^${BEL}${ESC}\\n]*(?=\\n|$)`,
  "g",
);
const singleEscapePattern = new RegExp(`${ESC}[\\x20-\\x2f]*[\\x30-\\x7e]`, "g");
const markdownMetaPattern = /([\\`*_{}[\]()#+\-.!|>])/g;

export function sanitizeTerminalText(value: string): string {
  const strippedSequences = value
    .replace(/\r\n?/g, "\n")
    .replace(oscPattern, "")
    .replace(unterminatedOscPattern, "")
    .replace(stringControlPattern, "")
    .replace(unterminatedStringControlPattern, "")
    .replace(csiPattern, "")
    .replace(singleEscapePattern, "");
  return stripUnsafeControls(strippedSequences);
}

export function escapeMarkdownText(value: string): string {
  return value.replace(markdownMetaPattern, "\\$1");
}

export function safePlainText(value: string | undefined): string {
  return sanitizeTerminalText(value ?? "");
}

export function safeMarkdownText(value: string | undefined): string {
  return escapeMarkdownText(safePlainText(value));
}

function stripUnsafeControls(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    const allowed = code === 0x09 || code === 0x0a || code >= 0x20;
    if (allowed && (code < 0x7f || code > 0x9f)) {
      result += char;
    }
  }
  return result;
}
