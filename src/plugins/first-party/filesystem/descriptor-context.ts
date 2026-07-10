import type { FileViewStore } from "./file-view-store";
import type { RangeEdit, RecentFileOperation, SearchResult } from "./model";

export type FilesystemDescriptorContext = {
  root: string;
  focusPath: string;
  recent: readonly RecentFileOperation[];
  lastSearch: {
    pattern: string;
    basePath: string;
    results: SearchResult[];
  } | null;
  views: FileViewStore;
  setFocus: (path: string) => Promise<unknown>;
  read: (path: string, range?: { startLine?: number; endLine?: number }) => Promise<unknown>;
  write: (path: string, content: string, expectedVersion?: number) => Promise<unknown>;
  edit: (
    path: string,
    edits: ReadonlyArray<{ oldText: string; newText: string }>,
    expectedVersion?: number,
  ) => Promise<unknown>;
  editRange: (
    path: string,
    sourceVersion: number | undefined,
    edits: ReadonlyArray<RangeEdit>,
    expectedVersion?: number,
  ) => Promise<unknown>;
  makeDirectory: (path: string) => Promise<unknown>;
  search: (pattern: string, path?: string) => Promise<unknown>;
  closeView: (viewId: string) => unknown;
  closeAllViews: () => unknown;
};
