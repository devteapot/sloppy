import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

import { matchSlashEntryList, type SlashEntry } from "../state/slash-catalog";
import { sanitizeTerminalText } from "./render-safety";
import { accent, bold, dim } from "./theme";

const DEFAULT_LIMIT = 8;

export class SlashAutocompleteProvider implements AutocompleteProvider {
  private entries: SlashEntry[];

  constructor(entries: SlashEntry[] = []) {
    this.entries = entries;
  }

  setEntries(entries: SlashEntry[]): void {
    this.entries = entries;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    if (options.force || options.signal.aborted || cursorLine !== 0) {
      return null;
    }

    const currentLine = lines[cursorLine] ?? "";
    const textBeforeCursor = currentLine.slice(0, cursorCol);
    const commandPrefix = commandPrefixBeforeCursor(textBeforeCursor);
    if (!commandPrefix) {
      return null;
    }

    const query = commandPrefix.slice(1);
    const suggestions = matchSlashEntryList(commandPrefix, this.entries, DEFAULT_LIMIT);
    if (suggestions.length === 0) {
      return null;
    }

    return {
      prefix: commandPrefix,
      items: suggestions.map(({ entry, insertion }): AutocompleteItem => {
        const label = sanitizeTerminalText(entry.name);
        const description = sanitizeTerminalText(
          entry.signature ? `${entry.signature} - ${entry.description}` : entry.description,
        );
        return {
          value: insertion,
          label: highlightCommandLabel(label, query),
          description: description.length > 0 ? description : undefined,
        };
      }),
    };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const currentLine = lines[cursorLine] ?? "";
    const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
    const afterCursor = currentLine.slice(cursorCol);
    const separator = afterCursor.startsWith(" ") ? "" : " ";
    const newLine = `${beforePrefix}/${item.value}${separator}${afterCursor}`;
    const newLines = [...lines];
    newLines[cursorLine] = newLine;
    return {
      lines: newLines,
      cursorLine,
      cursorCol: beforePrefix.length + item.value.length + 2,
    };
  }
}

function commandPrefixBeforeCursor(textBeforeCursor: string): string | null {
  const leadingWhitespace = textBeforeCursor.match(/^\s*/)?.[0] ?? "";
  const commandPrefix = textBeforeCursor.slice(leadingWhitespace.length);
  if (!commandPrefix.startsWith("/") || /\s/.test(commandPrefix)) {
    return null;
  }
  return commandPrefix;
}

function highlightCommandLabel(label: string, query: string): string {
  if (query.length === 0) {
    return label;
  }

  const lowerLabel = label.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const start = lowerLabel.indexOf(lowerQuery);
  if (start >= 0) {
    const end = start + query.length;
    return `${label.slice(0, start)}${accent(bold(label.slice(start, end)))}${label.slice(end)}`;
  }

  let queryIndex = 0;
  let rendered = "";
  for (const char of label) {
    if (queryIndex < lowerQuery.length && char.toLowerCase() === lowerQuery[queryIndex]) {
      rendered += accent(bold(char));
      queryIndex += 1;
    } else {
      rendered += char;
    }
  }

  return queryIndex === lowerQuery.length ? rendered : `${label} ${dim(`(${query})`)}`;
}
