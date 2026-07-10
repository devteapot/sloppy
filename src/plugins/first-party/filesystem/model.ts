import type { DiffHunk } from "../../../core/diff";

export type SearchResult = {
  id: string;
  path: string;
  line: number;
  preview: string;
};

export type RecentFileOperation = {
  id: string;
  action: string;
  path: string;
  detail?: string;
};

export type RangeEdit = {
  startLine: number;
  endLine: number;
  newText: string;
};

export type EditSuccessResult = {
  path: string;
  bytes: number;
  version: number;
  edits_applied: number;
  old_bytes: number;
  new_bytes: number;
  hunks: DiffHunk[];
};

export type SourceSnapshot = {
  path: string;
  version: number;
  totalLines: number;
  lines: Map<number, string>;
};

export type FileViewCoverage = "full" | "range" | "preview";

export type FileView = {
  id: string;
  path: string;
  absolutePath: string;
  coverage: FileViewCoverage;
  content: string;
  version: number;
  sourceVersion?: number;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  totalBytes?: number;
  truncated: boolean;
  previewOnly?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type FileViewResult = {
  path: string;
  view_path: string;
  view_id: string;
  coverage: FileViewCoverage;
  truncated: boolean;
  version: number;
  exists: true;
  kind: "file";
  already_loaded?: boolean;
  stale?: boolean;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  total_bytes?: number;
  preview_only?: boolean;
  source_version?: number;
};
