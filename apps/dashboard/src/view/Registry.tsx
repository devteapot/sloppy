import { createMemo, For, Show } from "solid-js";
import type { DashboardStore } from "../data/store";
import type { FileNode } from "../data/types";

type FileTree = {
  dirs: Map<string, FileTree>;
  files: FileNode[];
};

type Row =
  | { kind: "dir"; name: string; depth: number; path: string }
  | { kind: "file"; depth: number; file: FileNode };

function emptyTree(): FileTree {
  return { dirs: new Map(), files: [] };
}

function buildTree(files: FileNode[]): FileTree {
  const root = emptyTree();
  for (const file of files) {
    const parts = file.path.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      let child = node.dirs.get(seg);
      if (!child) {
        child = emptyTree();
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.files.push(file);
  }
  return root;
}

function flatten(tree: FileTree): Row[] {
  const rows: Row[] = [];
  const walk = (node: FileTree, depth: number, prefix: string) => {
    const dirNames = [...node.dirs.keys()].sort();
    for (const name of dirNames) {
      const path = prefix ? `${prefix}/${name}` : name;
      rows.push({ kind: "dir", name, depth, path });
      walk(node.dirs.get(name)!, depth + 1, path);
    }
    const sorted = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
    for (const f of sorted) rows.push({ kind: "file", depth, file: f });
  };
  walk(tree, 0, "");
  return rows;
}

export function Registry(props: { store: DashboardStore }) {
  const fileList = createMemo(() => Object.values(props.store.files));
  const rows = createMemo(() => flatten(buildTree(fileList())));

  return (
    <aside class="registry-pane">
      <header class="pane-head">
        <span class="pane-kicker">REGISTRY</span>
        <span class="pane-title">Shared resources</span>
        <span class="pane-meta">{fileList().length} files</span>
      </header>
      <Show when={rows().length === 0}>
        <div class="pane-empty">no files touched yet</div>
      </Show>
      <ul class="file-tree">
        <For each={rows()}>
          {(row) =>
            row.kind === "dir" ? (
              <DirRow row={row} />
            ) : (
              <FileRow row={row} store={props.store} />
            )
          }
        </For>
      </ul>
    </aside>
  );
}

function DirRow(props: { row: Extract<Row, { kind: "dir" }> }) {
  return (
    <li class="tree-row dir" style={{ "padding-left": `${8 + props.row.depth * 14}px` }}>
      <span class="dir-caret">▸</span>
      <span class="dir-name">{props.row.name}</span>
    </li>
  );
}

function FileRow(props: { row: Extract<Row, { kind: "file" }>; store: DashboardStore }) {
  const file = () => props.row.file;
  const recentWrite = () => props.store.recentWrites[file().path];
  const fresh = () => {
    const w = recentWrite();
    return w !== undefined && Date.now() - w.at < 5000;
  };
  const liveMode = (): "" | "in-read" | "in-write" | "in-prop" => {
    const ops = Object.values(props.store.activeOps).filter(
      (op) => op.filePath === file().path && !op.completedAt,
    );
    if (ops.length === 0) return "";
    if (ops.some((o) => o.propagationFromAgent && (o.op === "read" || o.op === "search")))
      return "in-prop";
    if (ops.some((o) => o.op === "write" || o.op === "mkdir")) return "in-write";
    if (ops.some((o) => o.op === "read" || o.op === "search")) return "in-read";
    return "";
  };
  const classes = () =>
    `tree-row file${liveMode() ? ` ${liveMode()}` : ""}${fresh() ? " fresh" : ""}`;
  return (
    <li
      class={classes()}
      style={{ "padding-left": `${8 + props.row.depth * 14}px` }}
      title={file().path}
    >
      <span class="file-row-name">{baseName(file().path)}</span>
      <span class="file-row-stats mono">
        r{file().reads} w{file().writes}
      </span>
    </li>
  );
}

function baseName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}
