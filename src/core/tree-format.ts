import type { SlopNode } from "@slop-ai/consumer/browser";

function formatValue(value: unknown): string {
  return JSON.stringify(value);
}

function formatAffordanceParams(params: unknown): string {
  if (!params || typeof params !== "object") {
    return "";
  }
  const properties = (params as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object") {
    return "";
  }
  return Object.entries(properties as Record<string, { type?: unknown }>)
    .map(([key, schema]) => `${key}: ${typeof schema.type === "string" ? schema.type : "unknown"}`)
    .join(", ");
}

export function formatStateTree(node: SlopNode, indent = 0): string {
  const pad = "  ".repeat(indent);
  const props = node.properties ?? {};
  const meta = node.meta ?? {};
  const displayName = (props.label ?? props.title) as string | undefined;
  const header = displayName && displayName !== node.id ? `${node.id}: ${displayName}` : node.id;
  const extra = Object.entries(props)
    .filter(([key]) => key !== "label" && key !== "title")
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(", ");
  const affordances = (node.affordances ?? [])
    .map((affordance) => {
      const params = formatAffordanceParams(affordance.params);
      return params ? `${affordance.action}(${params})` : affordance.action;
    })
    .join(", ");

  let line = `${pad}[${node.type}] ${header}`;
  if (extra) line += ` (${extra})`;
  if (meta.summary) line += `  — "${meta.summary}"`;
  if (affordances) line += `  actions: {${affordances}}`;

  const lines = [line];
  const childCount = node.children?.length ?? 0;
  const totalChildren = meta.total_children as number | undefined;
  if (totalChildren != null && totalChildren > childCount) {
    const window = meta.window as [number, number] | undefined;
    if (window) {
      lines.push(`${pad}  (showing ${childCount} of ${totalChildren})`);
    } else if (childCount === 0) {
      lines.push(
        `${pad}  (${totalChildren} ${totalChildren === 1 ? "child" : "children"} not loaded)`,
      );
    }
  }

  for (const child of node.children ?? []) {
    lines.push(formatStateTree(child, indent + 1));
  }

  return lines.join("\n");
}
