import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SlopNode } from "@slop-ai/consumer/browser";

import { reloadDebugFromEnv } from "../src/core/debug";
import { buildRuntimeToolSet } from "../src/core/tools";

const originalDebug = process.env.SLOPPY_DEBUG;
let originalStderrWrite: typeof process.stderr.write;
let capturedStderr: string[] = [];

beforeEach(() => {
  capturedStderr = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    capturedStderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  if (originalDebug === undefined) {
    delete process.env.SLOPPY_DEBUG;
  } else {
    process.env.SLOPPY_DEBUG = originalDebug;
  }
  reloadDebugFromEnv();
});

describe("buildRuntimeToolSet", () => {
  test("adds observation tools and prefixes affordance tools by provider", () => {
    const overviewTree: SlopNode = {
      id: "filesystem",
      type: "root",
      children: [
        {
          id: "workspace",
          type: "collection",
          affordances: [
            {
              action: "search",
              description: "Search the workspace.",
              params: {
                type: "object",
                properties: {
                  pattern: { type: "string" },
                },
                required: ["pattern"],
              },
            },
          ],
          children: [
            {
              id: "a.txt",
              type: "item",
              affordances: [{ action: "read", description: "Read the file." }],
            },
            {
              id: "b.txt",
              type: "item",
              affordances: [{ action: "read", description: "Read the file." }],
            },
          ],
        },
      ],
    };

    const toolSet = buildRuntimeToolSet([
      {
        providerId: "filesystem",
        providerName: "Filesystem",
        kind: "builtin",
        overviewTree,
      },
    ]);

    const toolNames = toolSet.tools.map((tool) => tool.function.name);
    expect(toolNames).toContain("slop_query_state");
    expect(toolNames).toContain("slop_focus_state");
    expect(toolNames).toContain("filesystem__workspace__search");
    expect(
      toolNames.some(
        (toolName) => toolName.startsWith("filesystem__") && toolName.includes("read"),
      ),
    ).toBe(true);
    expect(toolSet.resolve("filesystem__workspace__search")).toMatchObject({
      kind: "affordance",
      dangerous: false,
      idempotent: false,
    });
  });

  test("normalizes affordance params to strict JSON Schema for LLM tools", () => {
    const overviewTree: SlopNode = {
      id: "filesystem",
      type: "root",
      children: [
        {
          id: "workspace",
          type: "collection",
          affordances: [
            {
              action: "write",
              description: "Write a file.",
              params: {
                type: "object",
                properties: {
                  path: { type: "string", description: "File path. Required." },
                  content: { type: "string", description: "File content. Required." },
                  expected_version: {
                    type: "number",
                    description: "Optional CAS guard.",
                  },
                },
                required: ["path", "content", "expected_version"],
              },
            },
          ],
        },
      ],
    };

    const toolSet = buildRuntimeToolSet([
      {
        providerId: "filesystem",
        providerName: "Filesystem",
        kind: "builtin",
        overviewTree,
      },
    ]);
    const writeTool = toolSet.tools.find(
      (tool) => tool.function.name === "filesystem__workspace__write",
    );

    expect(writeTool).toBeDefined();
    expect(writeTool?.function.parameters).toMatchObject({
      type: "object",
      required: ["path", "content"],
      additionalProperties: false,
    });
    expect(writeTool?.function.description).toContain("Required parameters: path, content.");
    expect(writeTool?.function.description).toContain("Optional parameters: expected_version.");
  });

  test("preserves dangerous and idempotent affordance metadata in resolutions", () => {
    const overviewTree: SlopNode = {
      id: "filesystem",
      type: "root",
      children: [
        {
          id: "workspace",
          type: "collection",
          affordances: [
            {
              action: "read",
              description: "Read a file.",
              idempotent: true,
            },
            {
              action: "delete",
              description: "Delete a file.",
              dangerous: true,
            },
          ],
        },
      ],
    };

    const toolSet = buildRuntimeToolSet([
      {
        providerId: "filesystem",
        providerName: "Filesystem",
        kind: "builtin",
        overviewTree,
      },
    ]);

    expect(toolSet.resolve("filesystem__workspace__read")).toMatchObject({
      kind: "affordance",
      dangerous: false,
      idempotent: true,
    });
    expect(toolSet.resolve("filesystem__workspace__delete")).toMatchObject({
      kind: "affordance",
      dangerous: true,
      idempotent: false,
    });
  });

  test("preserves nested array item schemas when normalizing affordance params", () => {
    const overviewTree: SlopNode = {
      id: "filesystem",
      type: "root",
      children: [
        {
          id: "workspace",
          type: "collection",
          affordances: [
            {
              action: "edit",
              description: "Edit a file.",
              params: {
                type: "object",
                properties: {
                  path: { type: "string", description: "File path. Required." },
                  edits: {
                    type: "array",
                    description: "Replacement list. Required.",
                    items: {
                      type: "object",
                      properties: {
                        oldText: { type: "string" },
                        newText: { type: "string" },
                      },
                      required: ["oldText", "newText"],
                    },
                  },
                },
                required: ["path", "edits"],
              },
            },
          ],
        },
      ],
    };

    const toolSet = buildRuntimeToolSet([
      {
        providerId: "filesystem",
        providerName: "Filesystem",
        kind: "builtin",
        overviewTree,
      },
    ]);
    const editTool = toolSet.tools.find(
      (tool) => tool.function.name === "filesystem__workspace__edit",
    );

    expect(editTool?.function.parameters).toMatchObject({
      type: "object",
      required: ["path", "edits"],
      additionalProperties: false,
      properties: {
        edits: {
          type: "array",
          items: {
            type: "object",
            required: ["oldText", "newText"],
            additionalProperties: false,
          },
        },
      },
    });
  });

  test("fills missing array item schemas and honors optional markers", () => {
    const optionalStringSchema = { type: "string", optional: true } as unknown as {
      type: "string";
    };
    const overviewTree: SlopNode = {
      id: "memory",
      type: "root",
      children: [
        {
          id: "session",
          type: "context",
          affordances: [
            {
              action: "add_memory",
              description: "Store a memory.",
              params: {
                type: "object",
                properties: {
                  content: { type: "string" },
                  tags: {
                    type: "array",
                    description: "Categorization tags.",
                  },
                  ttl: optionalStringSchema,
                },
                required: ["content", "tags", "ttl"],
              },
            },
          ],
        },
      ],
    };

    const toolSet = buildRuntimeToolSet([
      {
        providerId: "memory",
        providerName: "Memory",
        kind: "builtin",
        overviewTree,
      },
    ]);
    const addMemoryTool = toolSet.tools.find(
      (tool) => tool.function.name === "memory__session__add_memory",
    );

    expect(addMemoryTool?.function.parameters).toMatchObject({
      type: "object",
      required: ["content", "tags"],
      additionalProperties: false,
      properties: {
        tags: {
          type: "array",
          items: {},
        },
        ttl: {
          type: "string",
        },
      },
    });
    expect(
      (
        addMemoryTool?.function.parameters.properties as
          | Record<string, Record<string, unknown>>
          | undefined
      )?.ttl?.optional,
    ).toBeUndefined();
  });

  test("debug-logs synthesized array items for external providers only", () => {
    process.env.SLOPPY_DEBUG = "tool-schema";
    reloadDebugFromEnv();

    const overviewTree: SlopNode = {
      id: "external-app",
      type: "root",
      children: [
        {
          id: "session",
          type: "context",
          affordances: [
            {
              action: "batch",
              description: "Run a batch.",
              params: {
                type: "object",
                properties: {
                  values: {
                    type: "array",
                    description: "Values to process.",
                  },
                },
                required: ["values"],
              },
            },
          ],
        },
      ],
    };

    buildRuntimeToolSet([
      {
        providerId: "external-app",
        providerName: "External App",
        kind: "external",
        overviewTree,
      },
    ]);

    buildRuntimeToolSet([
      {
        providerId: "builtin-app",
        providerName: "Builtin App",
        kind: "builtin",
        overviewTree,
      },
    ]);

    expect(capturedStderr).toHaveLength(1);
    const event = JSON.parse(capturedStderr[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event).toMatchObject({
      scope: "tool-schema",
      event: "array_items_synthesized",
      providerId: "external-app",
      toolName: "external-app__session__batch",
      schemaPath: "$.properties.values",
    });
  });
});
