import type { SlopNode } from "@slop-ai/consumer/browser";

export interface ProviderTreeView {
  providerId: string;
  providerName: string;
  kind: "first-party" | "external";
  overviewTree: SlopNode;
  focuses?: ProviderFocusView[];
}

export interface ProviderFocusView {
  path: string;
  tree: SlopNode;
}

function pathDepth(path: string): number {
  return path.replace(/^\//, "").split("/").filter(Boolean).length;
}

function upsertSubtree(node: SlopNode, segments: string[], subtree: SlopNode): SlopNode {
  if (segments.length === 0) {
    return structuredClone(subtree);
  }

  const [segment, ...rest] = segments;
  const clone = structuredClone(node);
  clone.children ??= [];
  const childIndex = clone.children.findIndex((child) => child.id === segment);

  if (rest.length === 0) {
    if (childIndex === -1) {
      clone.children.push(structuredClone(subtree));
    } else {
      clone.children[childIndex] = structuredClone(subtree);
    }
    return clone;
  }

  const child =
    childIndex === -1
      ? ({
          id: segment,
          type: "group",
          meta: {
            summary: "Synthetic ancestor for focused state.",
          },
        } satisfies SlopNode)
      : clone.children[childIndex];
  const nextChild = upsertSubtree(child, rest, subtree);
  if (childIndex === -1) {
    clone.children.push(nextChild);
  } else {
    clone.children[childIndex] = nextChild;
  }
  return clone;
}

export function buildVisibleTree(view: ProviderTreeView): SlopNode {
  const focuses = [...(view.focuses ?? [])].sort((left, right) => {
    const depth = pathDepth(left.path) - pathDepth(right.path);
    return depth === 0 ? left.path.localeCompare(right.path) : depth;
  });
  let visibleTree = structuredClone(view.overviewTree);

  for (const focus of focuses) {
    if (focus.path === "/") {
      visibleTree = structuredClone(focus.tree);
      continue;
    }
    const segments = focus.path.replace(/^\//, "").split("/").filter(Boolean);
    visibleTree = upsertSubtree(visibleTree, segments, focus.tree);
  }

  return visibleTree;
}
