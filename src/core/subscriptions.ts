import type { SlopNode } from "@slop-ai/consumer/browser";

export interface ProviderTreeView {
  providerId: string;
  providerName: string;
  kind: "builtin" | "external";
  overviewTree: SlopNode;
  detailPath?: string;
  detailTree?: SlopNode;
}

function replaceSubtree(node: SlopNode, segments: string[], subtree: SlopNode): SlopNode | null {
  if (segments.length === 0) {
    return structuredClone(subtree);
  }

  if (!node.children?.length) {
    return null;
  }

  const [segment, ...rest] = segments;
  const childIndex = node.children.findIndex((child) => child.id === segment);
  if (childIndex === -1) {
    return null;
  }

  const child = node.children[childIndex];
  if (!child) {
    return null;
  }

  const nextChild = replaceSubtree(child, rest, subtree);
  if (!nextChild) {
    return null;
  }

  const clone = structuredClone(node);
  clone.children ??= [];
  clone.children[childIndex] = nextChild;
  return clone;
}

export function buildVisibleTree(view: ProviderTreeView): SlopNode {
  if (!view.detailTree || !view.detailPath || view.detailPath === "/") {
    return structuredClone(view.detailTree ?? view.overviewTree);
  }

  const segments = view.detailPath.replace(/^\//, "").split("/").filter(Boolean);
  const replaced = replaceSubtree(view.overviewTree, segments, view.detailTree);
  return replaced ?? structuredClone(view.overviewTree);
}
