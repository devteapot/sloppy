import { type SelectItem, SelectList, type TUI } from "@earendil-works/pi-tui";

import type { PaletteCommand } from "../state/command-palette";
import { selectListTheme } from "./theme";

export class CommandPalette extends SelectList {
  private readonly byValue = new Map<string, PaletteCommand>();

  constructor(
    _tui: TUI,
    commands: PaletteCommand[],
    onSelectCommand: (command: PaletteCommand) => void,
    onCancel: () => void,
  ) {
    const items: SelectItem[] = commands.map((command) => ({
      value: command.id,
      label: command.label,
      description: command.description,
    }));
    super(items, 12, selectListTheme);
    for (const command of commands) {
      this.byValue.set(command.id, command);
    }
    this.onSelect = (item) => {
      const command = this.byValue.get(item.value);
      if (command) {
        onSelectCommand(command);
      }
    };
    this.onCancel = onCancel;
  }
}
