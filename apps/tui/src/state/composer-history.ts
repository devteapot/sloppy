export class ComposerHistory {
  private items: string[] = [];
  private cursor: number | null = null;

  constructor(private readonly capacity = 200) {}

  push(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    // Don't push duplicates of the most recent entry.
    if (this.items[this.items.length - 1] === trimmed) {
      this.cursor = null;
      return;
    }
    this.items.push(trimmed);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
    this.cursor = null;
  }

  reset(): void {
    this.cursor = null;
  }

  /** Move cursor backwards in history; returns the entry to display, or null if no change. */
  previous(): string | null {
    if (this.items.length === 0) {
      return null;
    }
    if (this.cursor === null) {
      this.cursor = this.items.length - 1;
    } else if (this.cursor > 0) {
      this.cursor -= 1;
    } else {
      return this.items[this.cursor];
    }
    return this.items[this.cursor];
  }

  /** Move cursor forwards in history; returns the entry, or empty string when past the end. */
  next(): string | null {
    if (this.cursor === null) {
      return null;
    }
    if (this.cursor < this.items.length - 1) {
      this.cursor += 1;
      return this.items[this.cursor];
    }
    this.cursor = null;
    return "";
  }

  list(): string[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }
}
