import { sanitizeTerminalText } from "./render-safety";

export type MarkdownRenderUnits = {
  stableUnits: string[];
  tailSource: string;
};

type FenceState = {
  marker: "`" | "~";
  length: number;
};

type SourceLine = {
  content: string;
  end: number;
  hasNewline: boolean;
  start: number;
};

const markdownFencePattern =
  /^([ \t]{0,3})(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n[ \t]{0,3}\2[ \t]*$/gm;
const referenceUsagePattern = /\[[^\]\n]+\]\[[^\]\n]*\]/;
const referenceDefinitionPattern = /(^|\n)[ \t]{0,3}\[[^\]\n]+\]:/;

export function prepareFinalAssistantMarkdown(source: string): string {
  return unwrapMarkdownTableFences(sanitizeTerminalText(source));
}

export function prepareTolerantAssistantMarkdown(source: string): string {
  return closeOpenFenceForRender(sanitizeTerminalText(source));
}

export function splitMarkdownRenderUnits(source: string): MarkdownRenderUnits {
  if (!source || hasReferenceLinkSyntax(source)) {
    return { stableUnits: [], tailSource: source };
  }

  const lines = sourceLines(source);
  const stableUnits: string[] = [];
  let unitStart = 0;
  let inFence: FenceState | null = null;
  let previousLine: SourceLine | null = null;
  let inTable = false;
  let tableBodyRows = 0;

  const commitThrough = (end: number): void => {
    if (end > unitStart) {
      stableUnits.push(source.slice(unitStart, end));
    }
    unitStart = end;
    previousLine = null;
    inTable = false;
    tableBodyRows = 0;
  };

  const commitBefore = (line: SourceLine): void => {
    if (line.start > unitStart) {
      stableUnits.push(source.slice(unitStart, line.start));
    }
    unitStart = line.start;
    previousLine = null;
    inTable = false;
    tableBodyRows = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (inFence) {
      if (line.hasNewline && isClosingFence(line.content, inFence)) {
        inFence = null;
        commitThrough(line.end);
      }
      continue;
    }

    const openingFence = parseOpeningFence(line.content);
    if (openingFence) {
      inFence = openingFence;
      previousLine = line;
      continue;
    }

    if (inTable) {
      if (isBlankLine(line.content)) {
        if (line.hasNewline) {
          commitThrough(line.end);
        }
        continue;
      }
      if (!isPipeTableRow(line.content) && tableBodyRows > 0) {
        commitBefore(line);
        index -= 1;
        continue;
      }
      if (isPipeTableRow(line.content) && !isTableSeparatorLine(line.content)) {
        tableBodyRows += 1;
      }
      previousLine = line;
      continue;
    }

    if (
      previousLine &&
      previousLine.start === unitStart &&
      isPipeTableHeader(previousLine.content) &&
      isTableSeparatorLine(line.content)
    ) {
      inTable = true;
      tableBodyRows = 0;
      previousLine = line;
      continue;
    }

    if (isBlankLine(line.content)) {
      if (line.hasNewline) {
        commitThrough(line.end);
      }
      continue;
    }

    if (line.start === unitStart && line.hasNewline && isAtxHeading(line.content)) {
      commitThrough(line.end);
      continue;
    }

    if (line.start === unitStart && line.hasNewline && isThematicBreak(line.content)) {
      commitThrough(line.end);
      continue;
    }

    previousLine = line;
  }

  return { stableUnits, tailSource: source.slice(unitStart) };
}

export function closeOpenFenceForRender(source: string): string {
  const openFence = findOpenFence(source);
  if (!openFence) {
    return source;
  }
  return `${source}${source.endsWith("\n") ? "" : "\n"}${openFence.marker.repeat(
    openFence.length,
  )}`;
}

export function unwrapMarkdownTableFences(source: string): string {
  return source.replace(markdownFencePattern, (match, _indent, _fence, rawInfo, body) => {
    const lang = String(rawInfo ?? "")
      .trim()
      .split(/[ \t,]+/)[0]
      ?.toLowerCase();
    if ((lang === "md" || lang === "markdown") && containsPipeTable(body)) {
      return body;
    }
    return match;
  });
}

function hasReferenceLinkSyntax(source: string): boolean {
  return referenceUsagePattern.test(source) || referenceDefinitionPattern.test(source);
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline === -1 ? source.length : newline + 1;
    const raw = source.slice(start, end);
    lines.push({
      content: raw.endsWith("\n") ? raw.slice(0, -1) : raw,
      end,
      hasNewline: newline !== -1,
      start,
    });
    start = end;
  }
  return lines;
}

function parseOpeningFence(line: string): FenceState | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})/.exec(line);
  if (!match) {
    return null;
  }
  const fence = match[1] ?? "";
  return { marker: fence[0] as "`" | "~", length: fence.length };
}

function isClosingFence(line: string, fence: FenceState): boolean {
  const pattern =
    fence.marker === "`"
      ? new RegExp(`^(?: {0,3})\`{${fence.length},}[ \\t]*$`)
      : new RegExp(`^(?: {0,3})~{${fence.length},}[ \\t]*$`);
  return pattern.test(line);
}

function findOpenFence(source: string): FenceState | null {
  let inFence: FenceState | null = null;
  for (const line of sourceLines(source)) {
    if (inFence) {
      if (isClosingFence(line.content, inFence)) {
        inFence = null;
      }
      continue;
    }
    inFence = parseOpeningFence(line.content);
  }
  return inFence;
}

function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

function isAtxHeading(line: string): boolean {
  return /^(?: {0,3})#{1,6}(?:\s+|$)/.test(line);
}

function isThematicBreak(line: string): boolean {
  return /^(?: {0,3})(?:([-*_])(?:[ \t]*\1){2,})[ \t]*$/.test(line);
}

function isPipeTableHeader(line: string): boolean {
  return line.includes("|") && !isTableSeparatorLine(line);
}

function isPipeTableRow(line: string): boolean {
  return line.includes("|");
}

function isTableSeparatorLine(line: string): boolean {
  if (!line.includes("|")) {
    return false;
  }
  const cells = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

function containsPipeTable(source: string): boolean {
  const lines = source.split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (isPipeTableHeader(lines[index] ?? "") && isTableSeparatorLine(lines[index + 1] ?? "")) {
      return true;
    }
  }
  return false;
}
