import type { SessionViewSnapshot } from "../slop/types";

export function formatStateTreeLines(node: SessionViewSnapshot["inspect"]["tree"]): string[] {
  if (!node) {
    return ["No query loaded. Try /query / 2"];
  }

  const lines: string[] = [];
  const visit = (current: NonNullable<typeof node>, path: string, depth: number) => {
    const actionSuffix =
      current.affordances && current.affordances.length > 0
        ? ` actions=${current.affordances.map((affordance) => affordance.action).join(",")}`
        : "";
    lines.push(`${"  ".repeat(depth)}${path} [${current.type}]${actionSuffix}`);
    const properties = compactObject(current.properties);
    if (properties) {
      lines.push(`${"  ".repeat(depth + 1)}props ${properties}`);
    }
    const meta = compactObject({
      summary: current.meta?.summary,
      salience: current.meta?.salience,
      focus: current.meta?.focus,
      urgency: current.meta?.urgency,
    });
    if (meta) {
      lines.push(`${"  ".repeat(depth + 1)}meta ${meta}`);
    }
    if (current.meta?.summary) {
      lines.push(`${"  ".repeat(depth + 1)}${current.meta.summary}`);
    }
    for (const child of current.children ?? []) {
      visit(child, `${path === "/" ? "" : path}/${child.id}`, depth + 1);
    }
  };
  visit(node, node.id === "root" ? "/" : `/${node.id}`, 0);
  return lines;
}

function compactObject(value: Record<string, unknown> | undefined): string {
  if (!value) {
    return "";
  }

  const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
  if (entries.length === 0) {
    return "";
  }

  return JSON.stringify(Object.fromEntries(entries));
}
