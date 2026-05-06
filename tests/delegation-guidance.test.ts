import { describe, expect, test } from "bun:test";

import { normalizeConfig } from "../src/config/load";
import { sloppyConfigSchema } from "../src/config/schema";
import { createBuiltinProviders } from "../src/providers/registry";
import { createDelegationWaitTool } from "../src/runtime/delegation";

function delegationOnlyConfig() {
  return normalizeConfig(
    sloppyConfigSchema.parse({
      providers: {
        builtin: {
          terminal: false,
          filesystem: false,
          memory: false,
          skills: false,
          web: false,
          browser: false,
          cron: false,
          messaging: false,
          delegation: true,
          metaRuntime: false,
          spec: false,
          vision: false,
          mcp: false,
          workspaces: false,
          a2a: false,
        },
        discovery: {
          enabled: false,
          paths: [],
        },
      },
    }),
    process.cwd(),
  );
}

describe("delegation model guidance", () => {
  test("delegation system prompt makes parent-side work and cleanup explicit", () => {
    const config = delegationOnlyConfig();
    const providers = createBuiltinProviders(config);

    try {
      const delegation = providers.find((provider) => provider.id === "delegation");
      const fragment = delegation?.systemPromptFragment?.(config) ?? "";

      expect(fragment).toContain("do your own independent work before the first delegation wait");
      expect(fragment).toContain("Call get_result before relying on a completed child's findings");
      expect(fragment).toContain("close that child session unless you need a follow-up turn");
    } finally {
      for (const provider of providers) {
        provider.stop?.();
      }
    }
  });

  test("wait tool description reminds the model to close final child sessions", () => {
    const description = createDelegationWaitTool().tool.function.description;

    expect(description).toContain("After retrieving a final result");
    expect(description).toContain("close that child");
  });
});
