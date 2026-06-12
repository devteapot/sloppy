// Text → speakable sentences. Two stages: `normalizeForSpeech` turns markdown
// reply text into plain spoken words (regex-based; tables/math degrade to plain
// words, which is acceptable spoken output), and `SentenceAssembler` cuts an
// incremental text stream into sentence-sized synthesis units so TTS requests
// can be pipelined.

/** Sentences shorter than this are merged into the next one (avoids choppy
 * one-word synthesis requests). */
const MIN_SENTENCE_CHARS = 25;
/** Hard cap per synthesis unit; long run-on text splits at a comma fallback. */
const MAX_SENTENCE_CHARS = 400;

/** Placeholder that survives whitespace collapsing (see normalizeForSpeech). */
const PARAGRAPH_MARK = "\u0000";

// Words whose trailing period does not end a sentence.
const ABBREVIATIONS = new Set([
  "mr.",
  "mrs.",
  "ms.",
  "dr.",
  "prof.",
  "sr.",
  "jr.",
  "st.",
  "vs.",
  "e.g.",
  "i.e.",
  "etc.",
  "no.",
  "u.s.",
  "inc.",
  "approx.",
]);

/**
 * Strip markdown down to text worth speaking. Fenced code blocks are dropped
 * entirely — reading code aloud is noise and the visual transcript still has
 * it. Paragraph breaks are preserved as "\n\n" so the assembler can treat them
 * as hard sentence boundaries.
 */
export function normalizeForSpeech(text: string): string {
  let out = text;
  // Fenced code blocks (terminated, then a trailing unterminated fence).
  out = out.replace(/```[\s\S]*?```/g, " ");
  out = out.replace(/```[\s\S]*$/, " ");
  // Images and links: keep the label, drop the URL.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Bare URLs.
  out = out.replace(/https?:\/\/\S+/g, "");
  // Inline code: keep the content.
  out = out.replace(/`([^`]*)`/g, "$1");
  // Table separator rows, then remaining pipes become plain spacing.
  out = out.replace(/^[ \t|:-]+$/gm, "");
  out = out.replace(/\|/g, " ");
  // Headings, blockquotes, list markers at line starts. Horizontal whitespace
  // only ([^\S\n]) — \s would swallow the newline of a preceding paragraph break.
  out = out.replace(/^#{1,6}[^\S\n]+/gm, "");
  out = out.replace(/^>[^\S\n]?/gm, "");
  out = out.replace(/^[^\S\n]*[-*+][^\S\n]+/gm, "");
  out = out.replace(/^[^\S\n]*\d+[.)][^\S\n]+/gm, "");
  // Emphasis markers (bold first so ** is not half-stripped).
  out = out.replace(/(\*\*|__)([^*_]+)\1/g, "$2");
  out = out.replace(/(\*|_)([^*_]+)\1/g, "$2");
  // Collapse whitespace, preserving paragraph breaks as hard boundaries: the
  // marker survives the \s+ collapse, then becomes "\n\n".
  out = out.replace(/\n{2,}/g, ` ${PARAGRAPH_MARK} `);
  out = out.replace(/\s+/g, " ");
  out = out.replace(new RegExp(` ?${PARAGRAPH_MARK} ?`, "g"), "\n\n");
  out = out.replace(/(\n\n)+/g, "\n\n");
  return out.trim();
}

/**
 * Incremental sentence splitter. `push` returns the sentences completed so
 * far; `flush` returns whatever remains. Splits at terminal punctuation
 * followed by whitespace and at paragraph breaks; avoids splitting after known
 * abbreviations and single-capital initials (decimals are naturally safe — no
 * whitespace follows the dot).
 */
export class SentenceAssembler {
  private buffer = "";
  private pending = "";

  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    for (;;) {
      const boundary = this.findBoundary();
      if (boundary === -1) {
        break;
      }
      const sentence = this.buffer.slice(0, boundary).trim();
      this.buffer = this.buffer.slice(boundary).replace(/^\s+/, "");
      this.emit(sentence, out);
    }
    // Run-on text with no boundary: split at a comma (or hard cap) so a single
    // synthesis unit stays bounded.
    while (this.pending.length + this.buffer.length > MAX_SENTENCE_CHARS) {
      const budget = MAX_SENTENCE_CHARS - this.pending.length;
      const comma = this.buffer.lastIndexOf(", ", budget);
      const cut = comma > 0 ? comma + 1 : budget;
      const piece = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut).replace(/^\s+/, "");
      this.emit(piece, out, { force: true });
    }
    return out;
  }

  flush(): string | null {
    const rest = `${this.pending} ${this.buffer}`.trim();
    this.pending = "";
    this.buffer = "";
    return rest.length > 0 ? rest : null;
  }

  private emit(sentence: string, out: string[], options: { force?: boolean } = {}): void {
    if (sentence.length === 0) {
      return;
    }
    const combined = this.pending ? `${this.pending} ${sentence}` : sentence;
    if (!options.force && combined.length < MIN_SENTENCE_CHARS) {
      this.pending = combined;
      return;
    }
    this.pending = "";
    out.push(combined);
  }

  /** Index just past the earliest confirmed sentence boundary, or -1. */
  private findBoundary(): number {
    const paragraph = this.buffer.indexOf("\n\n");
    const punctuation = this.findPunctuationBoundary(
      paragraph === -1 ? this.buffer.length : paragraph,
    );
    if (punctuation !== -1) {
      return punctuation;
    }
    return paragraph === -1 ? -1 : paragraph + 2;
  }

  private findPunctuationBoundary(limit: number): number {
    const re = /([.?!…]+)(\s+)/g;
    let match = re.exec(this.buffer);
    while (match && match.index < limit) {
      const end = match.index + match[1].length;
      const hardStop = match[1].includes("?") || match[1].includes("!");
      if (hardStop || !this.isNonTerminalDot(end)) {
        return end + match[2].length;
      }
      match = re.exec(this.buffer);
    }
    return -1;
  }

  /** True when the dot ending at `end` belongs to an abbreviation/initial. */
  private isNonTerminalDot(end: number): boolean {
    const prefix = this.buffer.slice(0, end);
    const word = prefix.match(/(\S+)$/)?.[1] ?? "";
    if (/^[A-Z]\.$/.test(word)) {
      return true;
    }
    return ABBREVIATIONS.has(word.toLowerCase());
  }
}
