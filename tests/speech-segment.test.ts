import { describe, expect, test } from "bun:test";

import { normalizeForSpeech, SentenceAssembler } from "../src/speech/segment";

function assemble(text: string): string[] {
  const assembler = new SentenceAssembler();
  const sentences = assembler.push(text);
  const rest = assembler.flush();
  return rest ? [...sentences, rest] : sentences;
}

describe("normalizeForSpeech", () => {
  test("drops fenced code blocks and keeps surrounding prose", () => {
    const input = "Here is the fix.\n\n```ts\nconst x = 1;\n```\n\nDeploy it after lunch.";
    expect(normalizeForSpeech(input)).toBe("Here is the fix.\n\nDeploy it after lunch.");
  });

  test("drops a trailing unterminated fence", () => {
    expect(normalizeForSpeech("Done.\n\n```ts\nconst x = 1;")).toBe("Done.");
  });

  test("keeps link labels, drops URLs, strips inline code", () => {
    const input =
      "See [the docs](https://example.com/a) and run `bun test`. More at https://example.com/b now.";
    expect(normalizeForSpeech(input)).toBe("See the docs and run bun test. More at now.");
  });

  test("strips headings, emphasis, blockquotes and list markers", () => {
    const input =
      "## Result\n\n> **All** _tests_ pass.\n\n- first item\n- second item\n1. third item";
    expect(normalizeForSpeech(input)).toBe(
      "Result\n\nAll tests pass.\n\nfirst item second item third item",
    );
  });

  test("degrades tables to plain words", () => {
    const input = "| name | count |\n|---|---|\n| foo | 2 |";
    expect(normalizeForSpeech(input)).toBe("name count\n\nfoo 2");
  });
});

describe("SentenceAssembler", () => {
  test("splits on terminal punctuation and merges short fragments", () => {
    expect(
      assemble("Yes. The deploy finished without errors. Everything looks healthy now."),
    ).toEqual(["Yes. The deploy finished without errors.", "Everything looks healthy now."]);
  });

  test("does not split after abbreviations, initials, or decimals", () => {
    expect(
      assemble("Dr. Smith met J. Doe at 3.5 km, e.g. near the station. They talked for a while."),
    ).toEqual([
      "Dr. Smith met J. Doe at 3.5 km, e.g. near the station.",
      "They talked for a while.",
    ]);
  });

  test("question and exclamation marks always split", () => {
    expect(
      assemble("Did the long-running migration finish? Yes! It completed early this morning."),
    ).toEqual(["Did the long-running migration finish?", "Yes! It completed early this morning."]);
  });

  test("paragraph breaks are hard boundaries even without punctuation", () => {
    expect(
      assemble("first paragraph without terminal punctuation\n\nsecond paragraph follows here"),
    ).toEqual(["first paragraph without terminal punctuation", "second paragraph follows here"]);
  });

  test("incremental pushes only emit completed sentences", () => {
    const assembler = new SentenceAssembler();
    expect(assembler.push("The quick brown fox jumps")).toEqual([]);
    expect(assembler.push(" over the lazy dog. And then")).toEqual([
      "The quick brown fox jumps over the lazy dog.",
    ]);
    expect(assembler.flush()).toBe("And then");
  });

  test("run-on text without boundaries splits at a comma before the cap", () => {
    const clause = "this clause keeps going and going without any terminal punctuation at all";
    const runOn = `${clause}, ${clause}, ${clause}, ${clause}, ${clause}, ${clause}`;
    const sentences = assemble(runOn);
    expect(sentences.length).toBeGreaterThan(1);
    for (const sentence of sentences) {
      expect(sentence.length).toBeLessThanOrEqual(400);
    }
    expect(sentences.join(" ").replace(/\s+/g, " ")).toBe(runOn.replace(/\s+/g, " "));
  });

  test("flush returns null when nothing remains", () => {
    const assembler = new SentenceAssembler();
    assembler.push("Complete sentence that is long enough to emit. ");
    assembler.flush();
    expect(assembler.flush()).toBeNull();
  });
});
