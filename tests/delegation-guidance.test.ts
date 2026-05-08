import { describe, expect, test } from "bun:test";

import { normalizeConfig } from "../src/config/load";
import { sloppyConfigSchema } from "../src/config/schema";
import { createDelegationWaitTool } from "../src/plugins/first-party/delegation/runtime";
import { createFirstPartyProviders } from "../src/providers/registry";

function delegationOnlyConfig() {
  return normalizeConfig(
    sloppyConfigSchema.parse({
      plugins: {
        terminal: { enabled: false },
        filesystem: { enabled: false },
        memory: { enabled: false },
        skills: { enabled: false },
        web: { enabled: false },
        browser: { enabled: false },
        cron: { enabled: false },
        messaging: { enabled: false },
        delegation: { enabled: true },
        "meta-runtime": { enabled: false },
        spec: { enabled: false },
        vision: { enabled: false },
        mcp: { enabled: false },
        workspaces: { enabled: false },
        a2a: { enabled: false },
      },
      providers: {
        discovery: { enabled: false, paths: [] },
      },
    }),
    process.cwd(),
  );
}

describe("delegation model guidance", () => {
  test("delegation system prompt makes parent-side work and cleanup explicit", () => {
    const config = delegationOnlyConfig();
    const providers = createFirstPartyProviders(config);

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
