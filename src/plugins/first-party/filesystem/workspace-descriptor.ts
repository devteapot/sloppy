import { readdirSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

import { action, type ItemDescriptor, type NodeDescriptor } from "@slop-ai/server";

import type { FilesystemDescriptorContext } from "./descriptor-context";
import {
  coerceEdits,
  coerceRangeEdits,
  EDIT_ITEM_SCHEMA,
  EDITS_DESCRIPTION,
  ENTRY_EDITS_DESCRIPTION,
  ENTRY_RANGE_EDITS_DESCRIPTION,
  RANGE_EDIT_ITEM_SCHEMA,
  RANGE_EDITS_DESCRIPTION,
  requirePathOrNestedEditPath,
  requireString,
  requireText,
  WORKSPACE_DIRECTORY_PATH_DESCRIPTION,
  WORKSPACE_FILE_PATH_DESCRIPTION,
} from "./input";
import { relativePath } from "./text";

function buildWorkspaceItems(context: FilesystemDescriptorContext): ItemDescriptor[] {
  const entries = readdirSync(context.focusPath, { withFileTypes: true });
  const sorted = [...entries].sort((left, right) => {
    if (left.isDirectory() && !right.isDirectory()) {
      return -1;
    }
    if (!left.isDirectory() && right.isDirectory()) {
      return 1;
    }
    return left.name.localeCompare(right.name);
  });

  const items: ItemDescriptor[] = [];
  for (const entry of sorted) {
    const fullPath = resolve(context.focusPath, entry.name);
    const info = statSync(fullPath);
    const relativeToRoot = relativePath(context.root, fullPath);
    const relativeToFocus = relativePath(context.focusPath, fullPath);
    const version = entry.isDirectory()
      ? undefined
      : context.views.observeVersion(fullPath, info.mtimeMs);

    items.push({
      id: entry.name,
      props: {
        name: entry.name,
        path: relativeToRoot,
        kind: entry.isDirectory() ? "directory" : "file",
        size: info.size,
        ext: entry.isDirectory() ? undefined : extname(entry.name) || undefined,
        modified: info.mtime.toISOString(),
        version,
      },
      summary: entry.isDirectory() ? `Directory ${relativeToRoot}` : `File ${relativeToRoot}`,
      actions: entry.isDirectory()
        ? {
            focus: action(async () => context.setFocus(relativeToRoot), {
              label: "Focus Directory",
              description: "Switch the focused directory to this entry.",
              idempotent: true,
              estimate: "instant",
            }),
          }
        : {
            read: action(
              {
                start_line: {
                  type: "number",
                  description:
                    "Optional 1-based start line. Pair with end_line to read a slice instead of the whole file.",
                  optional: true,
                },
                end_line: {
                  type: "number",
                  description: "Optional 1-based end line (inclusive).",
                  optional: true,
                },
              },
              async ({ start_line, end_line }) =>
                context.read(relativeToRoot, {
                  startLine: typeof start_line === "number" ? start_line : undefined,
                  endLine: typeof end_line === "number" ? end_line : undefined,
                }),
              {
                label: "Read File",
                description:
                  "Load this file as a provider-owned File view under /views and return a compact reference. Pass start_line/end_line to load a slice. Use source_version with edit_range for line-range edits against this observed view.",
                idempotent: true,
                estimate: "fast",
                resultKind: "code",
              },
            ),
            write: action(
              {
                content: "string",
                expected_version: {
                  type: "number",
                  description:
                    "Optional CAS guard. Pass the version returned by the last read to serialize concurrent writers. expected_version=0 succeeds only if the file does not exist yet (use it for atomic first-creation). expected_version=N (N>0) succeeds only if the file is currently at version N; otherwise returns { error: 'version_conflict', currentVersion }.",
                  optional: true,
                },
              },
              async ({ content, expected_version }) =>
                context.write(
                  relativeToRoot,
                  content as string,
                  typeof expected_version === "number" ? expected_version : undefined,
                ),
              {
                label: "Overwrite File",
                description:
                  "Replace this file entirely with new text content. Use `write` for new files, full rewrites, or regenerating a file from scratch; for targeted existing-file changes prefer `edit` or `edit_range`.",
                estimate: "fast",
              },
            ),
            edit: action(
              {
                edits: {
                  type: "array",
                  description: ENTRY_EDITS_DESCRIPTION,
                  items: EDIT_ITEM_SCHEMA,
                },
                expected_version: {
                  type: "number",
                  description:
                    "Optional CAS guard. Pass the version returned by the last read. expected_version=N succeeds only if the file is currently at version N; otherwise returns { error: 'version_conflict', currentVersion }. Edit does not create files — use write with expected_version=0 for first creation.",
                  optional: true,
                },
              },
              async ({ edits, expected_version }) =>
                context.edit(
                  relativeToRoot,
                  coerceEdits(edits),
                  typeof expected_version === "number" ? expected_version : undefined,
                ),
              {
                label: "Edit File",
                description:
                  "Apply one or more strict string-replacements to this file, atomically. Use for small unique string or intra-line replacements. For whole-line/block edits after a read returned source_version, prefer `edit_range`.",
                estimate: "fast",
                resultKind: "diff",
              },
            ),
            edit_range: action(
              {
                source_version: {
                  type: "number",
                  description:
                    "Required source view returned by a prior read of this file. The provider validates current file lines against the remembered source view before applying edits.",
                },
                edits: {
                  type: "array",
                  description: ENTRY_RANGE_EDITS_DESCRIPTION,
                  items: RANGE_EDIT_ITEM_SCHEMA,
                },
                expected_version: {
                  type: "number",
                  description:
                    "Optional strict whole-file CAS guard. Omit this to allow unrelated file changes when the edited range still matches the remembered source view.",
                  optional: true,
                },
              },
              async ({ source_version, edits, expected_version }) =>
                context.editRange(
                  relativeToRoot,
                  typeof source_version === "number" ? source_version : undefined,
                  coerceRangeEdits(edits),
                  typeof expected_version === "number" ? expected_version : undefined,
                ),
              {
                label: "Edit Line Range",
                description:
                  "Apply one or more line-range replacements to this file using the remembered source view from a prior read. Preferred for whole-line/block edits when line numbers are known.",
                estimate: "fast",
                resultKind: "diff",
              },
            ),
          },
      children: entry.isDirectory()
        ? undefined
        : {
            path: {
              type: "document",
              props: {
                path: relativeToRoot,
                relativeToFocus,
              },
              summary: `Use the read affordance on ${entry.name} to load a File view under /views.`,
            },
          },
    });
  }

  return items;
}

export function buildWorkspaceDescriptor(context: FilesystemDescriptorContext): NodeDescriptor {
  const items = buildWorkspaceItems(context);
  return {
    type: "collection",
    props: {
      root: context.root,
      focus: relativePath(context.root, context.focusPath),
      absolute_path: context.focusPath,
    },
    summary: `Focused directory ${relativePath(context.root, context.focusPath)}`,
    actions: {
      set_focus: action(
        {
          path: {
            type: "string",
            description: WORKSPACE_DIRECTORY_PATH_DESCRIPTION,
          },
        },
        async ({ path }) => context.setFocus(requireString(path, "path")),
        {
          label: "Set Focus",
          description:
            "Move the filesystem focus to a directory under the workspace root. The path is a filesystem path, not a SLOP path.",
          idempotent: true,
          estimate: "instant",
        },
      ),
      read: action(
        {
          path: {
            type: "string",
            description:
              "File or directory path relative to the filesystem workspace root, e.g. 'todo-app/src/App.jsx' or 'todo-app/src'. Required.",
          },
          start_line: {
            type: "number",
            description:
              "Optional 1-based start line. Pair with end_line to read a slice instead of the whole file.",
            optional: true,
          },
          end_line: {
            type: "number",
            description: "Optional 1-based end line (inclusive).",
            optional: true,
          },
        },
        async ({ path, start_line, end_line }) =>
          context.read(requireString(path, "path"), {
            startLine: typeof start_line === "number" ? start_line : undefined,
            endLine: typeof end_line === "number" ? end_line : undefined,
          }),
        {
          label: "Read By Path",
          description:
            "Read a path relative to the workspace root. For text files, loads a provider-owned File view under /views and returns { view_path, version, source_version, exists, kind: 'file', ... } without file content in the result. For directories, returns { kind: 'directory', entries, content } as a compact listing. For a nonexistent file returns { content: '', version: 0, exists: false } so callers can use a uniform read->write(expected_version) loop. Pass start_line/end_line to load a slice of an existing file. Use source_version with edit_range for line-range edits against the observed view.",
          idempotent: true,
          estimate: "fast",
          resultKind: "code",
        },
      ),
      write: action(
        {
          path: {
            type: "string",
            description: WORKSPACE_FILE_PATH_DESCRIPTION,
          },
          content: {
            type: "string",
            description:
              "Full new UTF-8 text content for the file as one valid JSON string. Required. Newlines must be escaped by the tool-call serializer; if generating a very large file is error-prone, create a minimal file first and then use edit for smaller targeted replacements.",
          },
          expected_version: {
            type: "number",
            description:
              "Optional CAS guard. Pass the version returned by the last read to serialize concurrent writers. expected_version=0 succeeds only if the file does not exist yet (use it for atomic first-creation). expected_version=N (N>0) succeeds only if the file is currently at version N; otherwise returns { error: 'version_conflict', currentVersion }.",
            optional: true,
          },
        },
        async ({ path, content, expected_version }) =>
          context.write(
            requireString(path, "path"),
            requireText(content, "content"),
            typeof expected_version === "number" ? expected_version : undefined,
          ),
        {
          label: "Write By Path",
          description:
            "Write a text file relative to the workspace root. Use `write` for new files (with expected_version=0), full rewrites, or regeneration; for targeted existing-file changes prefer `edit` or `edit_range`.",
          estimate: "fast",
        },
      ),
      edit: action(
        {
          path: {
            type: "string",
            description: WORKSPACE_FILE_PATH_DESCRIPTION,
            optional: true,
          },
          edits: {
            type: "array",
            description: EDITS_DESCRIPTION,
            items: EDIT_ITEM_SCHEMA,
          },
          expected_version: {
            type: "number",
            description:
              "Optional CAS guard. Pass the version returned by the last read. expected_version=N succeeds only if the file is currently at version N; otherwise returns { error: 'version_conflict', currentVersion }. Edit does not create files — use write with expected_version=0 for first creation.",
            optional: true,
          },
        },
        async ({ path, edits, expected_version }) => {
          const resolvedPath = requirePathOrNestedEditPath(path, edits);
          return context.edit(
            resolvedPath,
            coerceEdits(edits),
            typeof expected_version === "number" ? expected_version : undefined,
          );
        },
        {
          label: "Edit By Path",
          description:
            "Apply one or more strict string-replacements to a file relative to the workspace root, atomically. Use for small unique string or intra-line replacements. For whole-line/block edits after a read returned source_version, prefer `edit_range`.",
          estimate: "fast",
          resultKind: "diff",
        },
      ),
      edit_range: action(
        {
          path: {
            type: "string",
            description: WORKSPACE_FILE_PATH_DESCRIPTION,
          },
          source_version: {
            type: "number",
            description:
              "Required source view returned by a prior read of this path. The provider validates current file lines against the remembered source view before applying edits.",
          },
          edits: {
            type: "array",
            description: RANGE_EDITS_DESCRIPTION,
            items: RANGE_EDIT_ITEM_SCHEMA,
          },
          expected_version: {
            type: "number",
            description:
              "Optional strict whole-file CAS guard. Omit this to allow unrelated file changes when the edited range still matches the remembered source view.",
            optional: true,
          },
        },
        async ({ path, source_version, edits, expected_version }) =>
          context.editRange(
            requireString(path, "path"),
            typeof source_version === "number" ? source_version : undefined,
            coerceRangeEdits(edits),
            typeof expected_version === "number" ? expected_version : undefined,
          ),
        {
          label: "Edit Line Range By Path",
          description:
            "Apply one or more line-range replacements using the remembered source view from a prior read. Preferred for whole-line/block edits when line numbers are known and oldText echoing would be noisy.",
          estimate: "fast",
          resultKind: "diff",
        },
      ),
      mkdir: action(
        {
          path: {
            type: "string",
            description:
              "Directory path relative to the filesystem workspace root, e.g. 'todo-app/src'. Required.",
          },
        },
        async ({ path }) => context.makeDirectory(requireString(path, "path")),
        {
          label: "Create Directory",
          description: "Create a directory under the workspace root.",
          estimate: "instant",
        },
      ),
      search: action(
        {
          pattern: "string",
          path: {
            type: "string",
            description: "Optional directory relative to the workspace root.",
            optional: true,
          },
        },
        async ({ pattern, path }) =>
          context.search(
            requireString(pattern, "pattern"),
            typeof path === "string" && path ? path : undefined,
          ),
        {
          label: "Search Workspace",
          description: "Search for matching text under the focused directory or a provided path.",
          estimate: "slow",
        },
      ),
    },
    children: {
      entries: {
        type: "collection",
        props: {
          path: relativePath(context.root, context.focusPath),
          count: items.length,
        },
        items,
      },
    },
  };
}
