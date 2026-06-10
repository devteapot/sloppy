import { type Component, Markdown, Text } from "@earendil-works/pi-tui";

import {
  prepareFinalAssistantMarkdown,
  prepareTolerantAssistantMarkdown,
  splitMarkdownRenderUnits,
} from "./markdown-normalization";
import { safePlainText, sanitizeTerminalText } from "./render-safety";
import { markdownTheme } from "./theme";

export type SafeMarkdownMode = "final" | "tolerant";

export class StreamingMarkdown implements Component {
  private cachedText?: string;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly unitCache = new Map<string, string[]>();

  constructor(
    private text: string,
    private readonly paddingX: number,
    private readonly paddingY: number,
  ) {}

  setText(text: string): void {
    if (this.text === text) {
      return;
    }
    this.text = text;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    // Stable units from the old text/width are dead weight; recomputing the
    // still-stable prefix once per invalidation is cheaper than holding every
    // (width, unit) pair for the lifetime of the component.
    this.unitCache.clear();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const source = sanitizeTerminalText(this.text);
    const { stableUnits, tailSource } = splitMarkdownRenderUnits(source);
    const lines = [
      ...stableUnits.flatMap((unit) => this.renderStableUnit(unit, width)),
      ...renderMarkdownLines(prepareTolerantAssistantMarkdown(tailSource), width, this.paddingX),
    ];
    const result = withVerticalPadding(lines, width, this.paddingY);

    this.cachedText = this.text;
    this.cachedWidth = width;
    this.cachedLines = result;
    return result;
  }

  private renderStableUnit(unit: string, width: number): string[] {
    const key = `${width}\u0000${unit}`;
    const cached = this.unitCache.get(key);
    if (cached) {
      return cached;
    }
    const lines = renderMarkdownLines(unit, width, this.paddingX);
    this.unitCache.set(key, lines);
    return lines;
  }
}

export class SafeMarkdown implements Component {
  private cachedPreparedText?: string;
  private cachedRawText?: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private text: string,
    private readonly mode: SafeMarkdownMode,
    private readonly paddingX: number,
    private readonly paddingY: number,
  ) {}

  setText(text: string): void {
    if (this.text === text) {
      return;
    }
    this.text = text;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedPreparedText = undefined;
    this.cachedRawText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    const prepared =
      this.mode === "final"
        ? prepareFinalAssistantMarkdown(this.text)
        : prepareTolerantAssistantMarkdown(this.text);
    if (
      this.cachedLines &&
      this.cachedRawText === this.text &&
      this.cachedPreparedText === prepared &&
      this.cachedWidth === width
    ) {
      return this.cachedLines;
    }

    const markdown = new Markdown(prepared, this.paddingX, this.paddingY, markdownTheme);
    const lines = markdown.render(width);

    this.cachedRawText = this.text;
    this.cachedPreparedText = prepared;
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

export class PlainTranscriptText implements Component {
  private cachedText?: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private text: string,
    private readonly paddingX: number,
    private readonly paddingY: number,
  ) {}

  setText(text: string): void {
    if (this.text === text) {
      return;
    }
    this.text = text;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const text = new Text(safePlainText(this.text), this.paddingX, this.paddingY);
    const lines = text.render(width);
    this.cachedText = this.text;
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

function renderMarkdownLines(source: string, width: number, paddingX: number): string[] {
  if (!source || source.trim().length === 0) {
    return [];
  }
  return new Markdown(source, paddingX, 0, markdownTheme).render(width);
}

function withVerticalPadding(lines: string[], width: number, paddingY: number): string[] {
  if (lines.length === 0) {
    return [];
  }
  const empty = " ".repeat(width);
  const padding = Array.from({ length: paddingY }, () => empty);
  return [...padding, ...lines, ...padding];
}
