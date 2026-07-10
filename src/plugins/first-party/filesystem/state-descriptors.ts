import { dirname } from "node:path";

import { action, type ItemDescriptor, type NodeDescriptor } from "@slop-ai/server";

import type { FilesystemDescriptorContext } from "./descriptor-context";
import { requireString } from "./input";

export function buildViewsDescriptor(context: FilesystemDescriptorContext): NodeDescriptor {
  const views = context.views.listViews().sort((left, right) => {
    const pathComparison = left.path.localeCompare(right.path);
    if (pathComparison !== 0) return pathComparison;
    const coverageComparison = left.coverage.localeCompare(right.coverage);
    if (coverageComparison !== 0) return coverageComparison;
    return left.id.localeCompare(right.id);
  });
  const items = views.map((view) => {
    const currentVersion = context.views.currentVersion(view);
    const stale = currentVersion !== view.version;
    return {
      id: view.id,
      props: {
        path: view.path,
        coverage: view.coverage,
        content: view.content,
        version: view.version,
        current_version: currentVersion,
        stale,
        truncated: view.truncated,
        preview_only: view.previewOnly ?? false,
        source_version: view.sourceVersion,
        start_line: view.startLine,
        end_line: view.endLine,
        total_lines: view.totalLines,
        total_bytes: view.totalBytes,
        created_at: view.createdAt,
        updated_at: view.updatedAt,
      },
      summary: stale
        ? `${view.path} ${view.coverage} view is stale (source v${view.version}, current v${currentVersion})`
        : `${view.path} ${view.coverage} view`,
      actions: {
        close_view: action(async () => context.closeView(view.id), {
          label: "Close File View",
          description:
            "Remove this loaded file view from filesystem provider state and future default projections.",
          idempotent: true,
          estimate: "instant",
        }),
      },
    } satisfies ItemDescriptor;
  });
  const staleCount = items.filter((item) => item.props.stale === true).length;

  return {
    type: "collection",
    props: {
      count: items.length,
      stale_count: staleCount,
    },
    summary:
      items.length === 0
        ? "No loaded file views."
        : `${items.length} loaded file view${items.length === 1 ? "" : "s"}${staleCount > 0 ? `, ${staleCount} stale` : ""}.`,
    actions: {
      close_view: action(
        {
          view_id: {
            type: "string",
            description: "Loaded file view id to remove.",
          },
        },
        async ({ view_id }) => context.closeView(requireString(view_id, "view_id")),
        {
          label: "Close File View",
          description: "Remove one loaded file view by id.",
          idempotent: true,
          estimate: "instant",
        },
      ),
      close_all: action(async () => context.closeAllViews(), {
        label: "Close All File Views",
        description: "Remove all loaded file views from filesystem provider state.",
        idempotent: true,
        estimate: "instant",
      }),
    },
    items,
  };
}

export function buildSearchDescriptor(context: FilesystemDescriptorContext): NodeDescriptor {
  return {
    type: "collection",
    props: {
      pattern: context.lastSearch?.pattern,
      basePath: context.lastSearch?.basePath,
      count: context.lastSearch?.results.length ?? 0,
    },
    summary: context.lastSearch
      ? `Last search '${context.lastSearch.pattern}' under ${context.lastSearch.basePath}`
      : "No active search.",
    items: (context.lastSearch?.results ?? []).map((result) => ({
      id: result.id,
      props: {
        path: result.path,
        line: result.line,
        preview: result.preview,
      },
      actions: {
        read: action(async () => context.read(result.path), {
          label: "Read Match File",
          description: "Read the file that contains this search hit.",
          idempotent: true,
          estimate: "fast",
          resultKind: "code",
        }),
        focus_parent: action(async () => context.setFocus(dirname(result.path)), {
          label: "Focus Parent Directory",
          description: "Move the filesystem focus to the search result's parent directory.",
          idempotent: true,
          estimate: "instant",
        }),
      },
    })),
  };
}

export function buildRecentDescriptor(context: FilesystemDescriptorContext): NodeDescriptor {
  return {
    type: "collection",
    props: {
      count: context.recent.length,
    },
    summary: "Recent filesystem operations.",
    items: context.recent.map((entry) => ({
      id: entry.id,
      props: {
        action: entry.action,
        path: entry.path,
        detail: entry.detail,
      },
    })),
  };
}
