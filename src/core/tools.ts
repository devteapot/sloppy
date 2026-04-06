import { affordancesToTools, type LlmTool, type SlopNode } from "@slop-ai/consumer/browser";

import { buildVisibleTree, type ProviderTreeView } from "./subscriptions";

export type RuntimeToolResolution =
  | {
      kind: "observation";
      action: "query_state" | "focus_state";
    }
  | {
      kind: "affordance";
      providerId: string;
      action: string;
      path: string | null;
      targets?: string[];
      dangerous: boolean;
    };

export interface RuntimeToolSet {
  tools: LlmTool[];
  resolve(toolName: string): RuntimeToolResolution | null;
}

function buildObservationTools(providerIds: string[]): LlmTool[] {
  const providerEnum = providerIds.length > 0 ? providerIds : ["terminal", "filesystem"];

  return [
    {
      type: "function",
      function: {
        name: "slop_query_state",
        description:
          "Query provider state without changing subscriptions. Use this to inspect a path more deeply or request a different window.",
        parameters: {
          type: "object",
          properties: {
            provider: {
              type: "string",
              enum: providerEnum,
              description: "Provider id to query.",
            },
            path: {
              type: "string",
              description: "Absolute SLOP path like /workspace or /tasks.",
            },
            depth: {
              type: "number",
              description: "How many levels deep to resolve. Use 0-4 for targeted reads.",
            },
            max_nodes: {
              type: "number",
              description: "Optional node budget for the snapshot.",
            },
            min_salience: {
              type: "number",
              description: "Optional salience filter from 0 to 1.",
            },
            window_offset: {
              type: "number",
              description: "Optional collection window offset.",
            },
            window_count: {
              type: "number",
              description: "Optional collection window size.",
            },
          },
          required: ["provider", "path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "slop_focus_state",
        description:
          "Change the consumer's detailed subscription to a path so future turns include that subtree in the visible state context.",
        parameters: {
          type: "object",
          properties: {
            provider: {
              type: "string",
              enum: providerEnum,
              description: "Provider id to focus.",
            },
            path: {
              type: "string",
              description: "Absolute SLOP path to keep in detailed focus.",
            },
            depth: {
              type: "number",
              description: "Optional detail subscription depth.",
            },
            max_nodes: {
              type: "number",
              description: "Optional node budget for the focused subscription.",
            },
          },
          required: ["provider", "path"],
        },
      },
    },
  ];
}

function prefixToolName(providerId: string, toolName: string): string {
  return `${providerId}__${toolName}`;
}

function normalizeTreeForTools(node: SlopNode, fallbackId: string, path: string): SlopNode {
  const nodeId = typeof node.id === "string" && node.id.length > 0 ? node.id : fallbackId;
  const children = (node.children ?? []).flatMap((child: SlopNode, index: number) => {
    if (typeof child.id !== "string" || child.id.length === 0) {
      console.warn(`[sloppy] skipped malformed provider node without id at ${path}`);
      return [];
    }

    return [normalizeTreeForTools(child, `${nodeId}_${index}`, `${path}/${child.id}`)];
  });

  return {
    ...node,
    id: nodeId,
    children,
  };
}

export function buildRuntimeToolSet(views: ProviderTreeView[]): RuntimeToolSet {
  const tools: LlmTool[] = [];
  const resolutions = new Map<string, RuntimeToolResolution>();

  for (const observationTool of buildObservationTools(views.map((view) => view.providerId))) {
    tools.push(observationTool);
    resolutions.set(observationTool.function.name, {
      kind: "observation",
      action: observationTool.function.name === "slop_focus_state" ? "focus_state" : "query_state",
    });
  }

  for (const view of views) {
    const visibleTree = normalizeTreeForTools(
      buildVisibleTree(view),
      view.providerId,
      `/${view.providerId}`,
    );
    const toolSet = affordancesToTools(visibleTree);

    for (const tool of toolSet.tools) {
      const prefixedName = prefixToolName(view.providerId, tool.function.name);
      const resolution = toolSet.resolve(tool.function.name) as {
        path: string | null;
        action: string;
        targets?: string[];
      } | null;
      if (!resolution) {
        continue;
      }

      resolutions.set(prefixedName, {
        kind: "affordance",
        providerId: view.providerId,
        action: resolution.action,
        path: resolution.path,
        targets: resolution.targets,
        dangerous: tool.function.description.includes("[DANGEROUS - confirm first]"),
      });
      tools.push({
        ...tool,
        function: {
          ...tool.function,
          name: prefixedName,
        },
      });
    }
  }

  return {
    tools,
    resolve(toolName: string) {
      return resolutions.get(toolName) ?? null;
    },
  };
}
