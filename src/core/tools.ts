import { createHash } from "node:crypto";
import { affordancesToTools, type LlmTool, type SlopNode } from "@slop-ai/consumer/browser";

import { debug } from "./debug";
import { buildVisibleTree, type ProviderTreeView } from "./subscriptions";

const TOOL_NAME_LIMIT = 64;

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

type JsonObject = Record<string, unknown>;

type SchemaNormalizationContext = {
  providerId: string;
  providerKind: ProviderTreeView["kind"];
  toolName: string;
  schemaPath: string;
};

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOptionalParameter(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (schema.optional === true) return true;
  const description = typeof schema.description === "string" ? schema.description : "";
  return /\boptional\b/i.test(description);
}

function childSchemaContext(
  context: SchemaNormalizationContext | undefined,
  segment: string,
): SchemaNormalizationContext | undefined {
  if (!context) return undefined;
  return {
    ...context,
    schemaPath: `${context.schemaPath}.${segment}`,
  };
}

function normalizeJsonSchema(schema: unknown, context?: SchemaNormalizationContext): JsonObject {
  const source = isRecord(schema) ? schema : {};
  const normalized: JsonObject = { ...source };
  delete normalized.optional;
  const properties = isRecord(source.properties) ? source.properties : undefined;

  if (source.type === "object" || properties) {
    const normalizedProperties: JsonObject = {};
    const optionalProperties = new Set<string>();
    for (const [key, propertySchema] of Object.entries(properties ?? {})) {
      if (isOptionalParameter(propertySchema)) {
        optionalProperties.add(key);
      }
      normalizedProperties[key] = normalizeJsonSchema(
        propertySchema,
        childSchemaContext(context, `properties.${key}`),
      );
    }

    const existingRequired = Array.isArray(source.required)
      ? source.required.filter((item): item is string => typeof item === "string")
      : Object.keys(normalizedProperties);
    const required = existingRequired.filter(
      (key) => Object.hasOwn(normalizedProperties, key) && !optionalProperties.has(key),
    );

    normalized.type = "object";
    normalized.properties = normalizedProperties;
    normalized.required = required;
    normalized.additionalProperties =
      typeof source.additionalProperties === "boolean" ? source.additionalProperties : false;
  }

  if (source.type === "array") {
    if (source.items === undefined && context?.providerKind === "external") {
      debug("tool-schema", "array_items_synthesized", {
        providerId: context.providerId,
        toolName: context.toolName,
        schemaPath: context.schemaPath,
      });
    }
    normalized.items = normalizeJsonSchema(source.items, childSchemaContext(context, "items"));
  }

  return normalized;
}

function parameterContractHint(parameters: JsonObject): string {
  const properties = isRecord(parameters.properties) ? parameters.properties : {};
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((item): item is string => typeof item === "string")
    : [];
  const optional = Object.keys(properties).filter((key) => !required.includes(key));
  const parts = [
    required.length > 0 ? `Required parameters: ${required.join(", ")}.` : "",
    optional.length > 0 ? `Optional parameters: ${optional.join(", ")}.` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

function withParameterContractDescription(description: string, parameters: JsonObject): string {
  const hint = parameterContractHint(parameters);
  return hint ? `${description} ${hint}` : description;
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
          additionalProperties: false,
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
          additionalProperties: false,
        },
      },
    },
  ];
}

export function buildToolName(
  providerId: string,
  toolName: string,
  limit = TOOL_NAME_LIMIT,
): string {
  const candidate = `${providerId}__${toolName}`;
  if (candidate.length <= limit) return candidate;
  const hash = createHash("sha256").update(candidate).digest("hex").slice(0, 7);
  return `${candidate.slice(0, limit - 8)}_${hash}`;
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
      const prefixedName = buildToolName(view.providerId, tool.function.name);
      if (resolutions.has(prefixedName)) {
        console.warn(
          `[sloppy] tool name collision after truncation: ${prefixedName} (${view.providerId}.${tool.function.name})`,
        );
      }
      const resolution = toolSet.resolve(tool.function.name) as {
        path: string | null;
        action: string;
        targets?: string[];
      } | null;
      if (!resolution) {
        continue;
      }

      const parameters = normalizeJsonSchema(tool.function.parameters, {
        providerId: view.providerId,
        providerKind: view.kind,
        toolName: prefixedName,
        schemaPath: "$",
      });
      const description = withParameterContractDescription(tool.function.description, parameters);

      resolutions.set(prefixedName, {
        kind: "affordance",
        providerId: view.providerId,
        action: resolution.action,
        path: resolution.path,
        targets: resolution.targets,
        dangerous: description.includes("[DANGEROUS - confirm first]"),
      });
      tools.push({
        ...tool,
        function: {
          ...tool.function,
          name: prefixedName,
          description,
          parameters,
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
