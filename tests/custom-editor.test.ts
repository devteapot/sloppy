import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Terminal, TUI, visibleWidth } from "@earendil-works/pi-tui";

import { ComposerAutocompleteProvider } from "../apps/tui/src/ui/composer-autocomplete";
import { CustomEditor } from "../apps/tui/src/ui/custom-editor";
import { FileAutocompleteProvider } from "../apps/tui/src/ui/file-autocomplete";

const ESC = "\x1b";
const BEL = "\x07";
const CURSOR_MARKER = "\x1b_pi:c\x07";

class TestTerminal implements Terminal {
  get columns(): number {
    return 80;
  }

  get rows(): number {
    return 24;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

function createEditorWithTui(): { tui: TUI; editor: CustomEditor } {
  const tui = new TUI(new TestTerminal());
  const editor = new CustomEditor(tui);
  tui.setFocus(editor);
  return { tui, editor };
}

function createEditor(): CustomEditor {
  return createEditorWithTui().editor;
}

async function runGit(root: string, args: string[]): Promise<void> {
  const subprocess = Bun.spawn(["git", "-C", root, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    subprocess.stdout ? new Response(subprocess.stdout).text() : Promise.resolve(""),
    subprocess.stderr ? new Response(subprocess.stderr).text() : Promise.resolve(""),
    subprocess.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
  }
}

function plain(value: string): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    if (value.startsWith(CURSOR_MARKER, index)) {
      index += CURSOR_MARKER.length;
      continue;
    }
    if (value[index] === ESC) {
      const next = value[index + 1];
      if (next === "[") {
        index += 2;
        while (index < value.length) {
          const code = value.charCodeAt(index);
          index += 1;
          if (code >= 0x40 && code <= 0x7e) {
            break;
          }
        }
        continue;
      }
      if (next === "]") {
        index += 2;
        while (index < value.length) {
          if (value[index] === BEL) {
            index += 1;
            break;
          }
          if (value[index] === ESC && value[index + 1] === "\\") {
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }
    }
    result += value[index] ?? "";
    index += 1;
  }
  return result;
}

describe("CustomEditor", () => {
  test("renders a rounded composer with mode label and prompt gutter", () => {
    const editor = createEditor();
    const lines = editor.render(56);

    expect(lines).toHaveLength(3);
    expect(plain(lines[0] ?? "")).toContain(" default ");
    expect(plain(lines[0] ?? "")).toMatch(/^╭─+ default ╮$/);
    expect(plain(lines[1] ?? "")).toContain("?> ");
    expect(plain(lines[1] ?? "")).toContain("Type a prompt, / for commands, or ! for shell");
    expect(plain(lines[2] ?? "")).toMatch(/^╰─+╯$/);
    expect(lines.every((line) => visibleWidth(line) === 56)).toBe(true);
  });

  test("renders typed text inside the composer without placeholder text", () => {
    const editor = createEditor();
    editor.setText("hello");

    const rendered = plain(editor.render(44).join("\n"));

    expect(rendered).toContain("hello");
    expect(rendered).not.toContain("Type a prompt");
  });

  test("updates the composer mode label", () => {
    const editor = createEditor();
    editor.setModeLabel("plan");

    expect(plain(editor.render(40)[0] ?? "")).toContain(" plan ");
  });

  test("colors the composer frame by mode", () => {
    const editor = createEditor();
    expect(editor.render(40)[0]).toContain("\x1b[2m");

    editor.setModeLabel("plan");
    const planLines = editor.render(40);
    expect(planLines[0]).toContain("\x1b[38;5;43m");
    expect(planLines[1]).toContain("\x1b[38;5;43m│");
    expect(planLines[2]).toContain("\x1b[38;5;43m");

    editor.setModeLabel("default");
    editor.setApprovalMode("auto");
    const autoApprovalLines = editor.render(40);
    expect(autoApprovalLines[0]).toContain("\x1b[2m");
    expect(autoApprovalLines[1]).toContain("\x1b[2m│");
    expect(autoApprovalLines[2]).toContain("\x1b[2m");
  });

  test("encodes approval mode and input intent in the prompt gutter", () => {
    const editor = createEditor();

    expect(plain(editor.render(40)[1] ?? "")).toContain("?> ");

    editor.setApprovalMode("auto");
    expect(plain(editor.render(40)[1] ?? "")).toContain("!> ");

    editor.setApprovalMode("normal");
    editor.setText("!pwd");
    expect(plain(editor.render(40)[1] ?? "")).toContain("?! pwd");

    editor.setApprovalMode("auto");
    expect(plain(editor.render(40)[1] ?? "")).toContain("!! pwd");

    editor.setText("/help");
    expect(plain(editor.render(40)[1] ?? "")).toContain("/  help");
  });

  test("does not rewrite leading @ paths on submission", () => {
    const editor = createEditor();

    expect(editor.prepareSubmission("@README.md")).toBe("@README.md");
    expect(editor.prepareSubmission("  @docs/16-tui-plan.md  ")).toBe("  @docs/16-tui-plan.md  ");
  });

  test("requests a redraw when clearing a slash draft", () => {
    const { tui, editor } = createEditorWithTui();
    let renderRequests = 0;
    tui.requestRender = () => {
      renderRequests += 1;
    };

    editor.setText("/help");
    renderRequests = 0;

    expect(editor.clearSlashDraft()).toBe(true);
    expect(editor.getText()).toBe("");
    expect(renderRequests).toBeGreaterThan(0);

    editor.setText("hello");
    renderRequests = 0;

    expect(editor.clearSlashDraft()).toBe(false);
    expect(renderRequests).toBe(0);
  });

  test("keeps slash and file completion triggers separate", async () => {
    const provider = new ComposerAutocompleteProvider();
    const slash = await provider.getSuggestions(["/he"], 0, 3, {
      signal: new AbortController().signal,
    });

    expect(slash?.prefix).toBe("/he");
    const appliedSlash = provider.applyCompletion(
      ["/he"],
      0,
      3,
      slash?.items[0] ?? { value: "", label: "" },
      slash?.prefix ?? "",
    );
    expect(appliedSlash.lines[0]?.startsWith("/")).toBe(true);

    const noFileTrigger = await provider.getSuggestions(["read README"], 0, 11, {
      signal: new AbortController().signal,
    });
    expect(noFileTrigger).toBeNull();
  });

  test("completes inline @ file references with fuzzy filename matching", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-tui-files-"));
    try {
      await mkdir(join(root, "apps/tui/src"), { recursive: true });
      await mkdir(join(root, "docs"), { recursive: true });
      await mkdir(join(root, "node_modules/ignored"), { recursive: true });
      await writeFile(join(root, "apps/tui/src/custom-editor.ts"), "export {};\n");
      await writeFile(join(root, "docs/My Notes.md"), "notes\n");
      await writeFile(join(root, "plain.txt"), "custom-editor content mention\n");
      await writeFile(join(root, "node_modules/ignored/custom-editor.ts"), "ignored\n");

      const provider = new FileAutocompleteProvider(root, { now: () => 1 });
      const fuzzy = await provider.getSuggestions(["please inspect @cmed"], 0, 20, {
        signal: new AbortController().signal,
      });

      expect(fuzzy?.prefix).toBe("@cmed");
      expect(fuzzy?.items[0]?.value).toBe("apps/tui/src/custom-editor.ts");
      expect(plain(fuzzy?.items[0]?.label ?? "")).toBe("custom-editor.ts");
      expect(fuzzy?.items.some((item) => item.description?.includes("node_modules"))).toBe(false);
      expect(fuzzy?.items.some((item) => item.description === "plain.txt")).toBe(false);

      const applied = provider.applyCompletion(
        ["please inspect @cmed"],
        0,
        20,
        fuzzy?.items[0] ?? { value: "", label: "" },
        fuzzy?.prefix ?? "",
      );
      expect(applied.lines[0]).toBe("please inspect apps/tui/src/custom-editor.ts ");

      const spaced = await provider.getSuggestions(["open @notes"], 0, 11, {
        signal: new AbortController().signal,
      });
      expect(spaced?.items[0]?.value).toBe('"docs/My Notes.md"');
      const appliedSpaced = provider.applyCompletion(
        ["open @notes"],
        0,
        11,
        spaced?.items[0] ?? { value: "", label: "" },
        spaced?.prefix ?? "",
      );
      expect(appliedSpaced.lines[0]).toBe('open "docs/My Notes.md" ');

      const parentPath = await provider.getSuggestions(["open @../custom-editor"], 0, 21, {
        signal: new AbortController().signal,
      });
      expect(parentPath).toBeNull();

      const absolutePath = await provider.getSuggestions(["open @/tui"], 0, 10, {
        signal: new AbortController().signal,
      });
      expect(absolutePath).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses gitignore-aware file discovery in git workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-tui-git-files-"));
    try {
      await runGit(root, ["init"]);
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "ignored"), { recursive: true });
      await writeFile(join(root, ".gitignore"), "ignored/\n");
      await writeFile(join(root, "src/visible.ts"), "export {};\n");
      await writeFile(join(root, "ignored/hidden.ts"), "ignored\n");

      const provider = new FileAutocompleteProvider(root, { now: () => 1 });
      const directory = await provider.getSuggestions(["open @src"], 0, 9, {
        signal: new AbortController().signal,
      });
      expect(directory?.items[0]?.value).toBe("src/");

      const visible = await provider.getSuggestions(["open @visible"], 0, 13, {
        signal: new AbortController().signal,
      });
      expect(visible?.items[0]?.value).toBe("src/visible.ts");

      const hidden = await provider.getSuggestions(["open @hidden"], 0, 12, {
        signal: new AbortController().signal,
      });
      expect(hidden).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
