import { describe, expect, test } from "bun:test";
import type { SlopNode } from "@slop-ai/consumer/browser";

import { buildRuntimeToolSet } from "../src/core/tools";

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
});
