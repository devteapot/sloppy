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
});
