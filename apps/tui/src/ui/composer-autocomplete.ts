import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

import { BUILTIN_SLASH_ENTRIES, type SlashEntry } from "../state/slash-catalog";
import { FileAutocompleteProvider } from "./file-autocomplete";
import { SlashAutocompleteProvider } from "./slash-autocomplete";

export class ComposerAutocompleteProvider implements AutocompleteProvider {
  private readonly slash = new SlashAutocompleteProvider(BUILTIN_SLASH_ENTRIES);
  private readonly files = new FileAutocompleteProvider();

  setSlashEntries(entries: SlashEntry[]): void {
    this.slash.setEntries(entries);
  }

  setWorkspaceRoot(root: string | null | undefined): void {
    this.files.setWorkspaceRoot(root);
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const slashSuggestions = await this.slash.getSuggestions(lines, cursorLine, cursorCol, options);
    if (slashSuggestions) {
      return slashSuggestions;
    }
    return this.files.getSuggestions(lines, cursorLine, cursorCol, options);
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    if (prefix.startsWith("/")) {
      return this.slash.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    }
    return this.files.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.files.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
  }
}
