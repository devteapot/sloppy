import type { SlopNode } from "@slop-ai/consumer/browser";

const KEY_SEPARATOR = "\u001f";

export class DangerousAffordanceIndex {
  private readonly keys = new Set<string>();

  has(providerId: string, path: string, action: string): boolean {
    return this.keys.has(buildKey(providerId, path, action));
  }

  record(providerId: string, tree: SlopNode, rootPath = "/"): boolean {
    let added = false;
    walkAffordances(tree, rootPath, (path, action, dangerous) => {
      if (!dangerous) return;
      const before = this.keys.size;
      this.keys.add(buildKey(providerId, path, action));
      added ||= this.keys.size > before;
    });
    return added;
  }

  clearProvider(providerId: string): void {
    const prefix = `${providerId}${KEY_SEPARATOR}`;
    for (const key of this.keys) {
      if (key.startsWith(prefix)) {
        this.keys.delete(key);
      }
    }
  }

  clear(): void {
    this.keys.clear();
  }
}

function buildKey(providerId: string, path: string, action: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return [providerId, normalizedPath, action].join(KEY_SEPARATOR);
}

function walkAffordances(
  node: SlopNode,
  path: string,
  visit: (path: string, action: string, dangerous: boolean) => void,
): void {
  for (const affordance of node.affordances ?? []) {
    visit(path, affordance.action, affordance.dangerous === true);
  }
  for (const child of node.children ?? []) {
    if (typeof child.id !== "string" || child.id.length === 0) continue;
    walkAffordances(child, joinPath(path, child.id), visit);
  }
}

function joinPath(parent: string, segment: string): string {
  return parent === "/" || parent === "" ? `/${segment}` : `${parent}/${segment}`;
}
