import { statSync } from "node:fs";

import { debug } from "../../../core/debug";
import type { FileView, FileViewResult, SourceSnapshot } from "./model";
import { relativePath } from "./text";

const SOURCE_SNAPSHOT_LIMIT = 64;

export class FileViewStore {
  private readonly fileVersions = new Map<string, number>();
  private readonly cachedMtimes = new Map<string, number>();
  private readonly sourceSnapshots = new Map<string, SourceSnapshot>();
  private readonly fileViews = new Map<string, FileView>();

  constructor(private readonly root: string) {}

  observeVersion(absolutePath: string, mtimeMs: number | null): number {
    const cachedMtime = this.cachedMtimes.get(absolutePath);
    const existing = this.fileVersions.get(absolutePath);

    if (existing === undefined) {
      if (mtimeMs == null) {
        return 0;
      }
      const initial = 1;
      this.fileVersions.set(absolutePath, initial);
      this.cachedMtimes.set(absolutePath, mtimeMs);
      return initial;
    }

    if (mtimeMs == null) {
      if (cachedMtime == null) {
        return existing;
      }
      const next = existing + 1;
      this.fileVersions.set(absolutePath, next);
      this.cachedMtimes.delete(absolutePath);
      debug("filesystem", "external_delete", {
        path: relativePath(this.root, absolutePath),
        previous_version: existing,
        version: next,
      });
      return next;
    }

    if (cachedMtime != null && mtimeMs !== cachedMtime) {
      const next = existing + 1;
      this.fileVersions.set(absolutePath, next);
      this.cachedMtimes.set(absolutePath, mtimeMs);
      debug("filesystem", "mtime_drift", {
        path: relativePath(this.root, absolutePath),
        cached_mtime: cachedMtime,
        actual_mtime: mtimeMs,
        version: next,
      });
      return next;
    }

    if (cachedMtime == null) {
      this.cachedMtimes.set(absolutePath, mtimeMs);
    }

    return existing;
  }

  bumpVersion(absolutePath: string, mtimeMs: number | null): number {
    const current = this.fileVersions.get(absolutePath) ?? 0;
    const next = current + 1;
    this.fileVersions.set(absolutePath, next);
    if (mtimeMs != null) {
      this.cachedMtimes.set(absolutePath, mtimeMs);
    } else {
      this.cachedMtimes.delete(absolutePath);
    }
    return next;
  }

  rememberSourceLines(
    path: string,
    version: number,
    lines: string[],
    startLine: number,
    endLine: number,
  ): void {
    const key = this.sourceSnapshotKey(path, version);
    const existing = this.sourceSnapshots.get(key);
    const snapshot =
      existing ??
      ({
        path,
        version,
        totalLines: lines.length,
        lines: new Map<number, string>(),
      } satisfies SourceSnapshot);

    snapshot.totalLines = Math.max(snapshot.totalLines, lines.length);
    for (let line = startLine; line <= endLine; line += 1) {
      snapshot.lines.set(line, lines[line - 1] ?? "");
    }

    if (existing) {
      this.sourceSnapshots.delete(key);
    }
    this.sourceSnapshots.set(key, snapshot);

    while (this.sourceSnapshots.size > SOURCE_SNAPSHOT_LIMIT) {
      const oldest = this.sourceSnapshots.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      this.sourceSnapshots.delete(oldest);
    }
  }

  sourceSnapshot(path: string, version: number): SourceSnapshot | undefined {
    return this.sourceSnapshots.get(this.sourceSnapshotKey(path, version));
  }

  fullViewFor(path: string, version: number): FileView | undefined {
    return this.listViews().find(
      (view) => view.path === path && view.version === version && view.coverage === "full",
    );
  }

  upsertView(input: Omit<FileView, "createdAt" | "updatedAt">): FileView {
    const existing = this.fileViews.get(input.id);
    const now = new Date().toISOString();
    const view: FileView = {
      ...input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.fileViews.set(view.id, view);

    if (view.coverage === "full") {
      for (const [id, candidate] of this.fileViews) {
        if (
          id !== view.id &&
          candidate.path === view.path &&
          candidate.version === view.version &&
          candidate.coverage === "range"
        ) {
          this.fileViews.delete(id);
        }
      }
    }

    return view;
  }

  result(
    view: FileView,
    options: { alreadyLoaded?: boolean; stale?: boolean } = {},
  ): FileViewResult {
    return {
      path: view.path,
      view_path: this.viewPath(view.id),
      view_id: view.id,
      coverage: view.coverage,
      truncated: view.truncated,
      version: view.version,
      exists: true,
      kind: "file",
      ...(options.alreadyLoaded ? { already_loaded: true } : {}),
      ...(options.stale ? { stale: true } : {}),
      ...(view.startLine !== undefined ? { startLine: view.startLine } : {}),
      ...(view.endLine !== undefined ? { endLine: view.endLine } : {}),
      ...(view.totalLines !== undefined ? { totalLines: view.totalLines } : {}),
      ...(view.totalBytes !== undefined ? { total_bytes: view.totalBytes } : {}),
      ...(view.previewOnly ? { preview_only: true } : {}),
      ...(view.sourceVersion !== undefined ? { source_version: view.sourceVersion } : {}),
    };
  }

  viewPath(viewId: string): string {
    return `/views/${viewId}`;
  }

  listViews(): FileView[] {
    return [...this.fileViews.values()];
  }

  closeView(viewId: string): boolean {
    return this.fileViews.delete(viewId);
  }

  clearViews(): number {
    const removed = this.fileViews.size;
    this.fileViews.clear();
    return removed;
  }

  currentVersion(view: FileView): number {
    try {
      const stat = statSync(view.absolutePath);
      return this.observeVersion(view.absolutePath, stat.mtimeMs);
    } catch {
      return this.observeVersion(view.absolutePath, null);
    }
  }

  private sourceSnapshotKey(path: string, version: number): string {
    return `${path}\0${version}`;
  }
}
