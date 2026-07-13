import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapProviderRuntime } from "../src/core/bootstrap";
import {
  DELEGATION_SERVICE,
  MESSAGING_SERVICE,
  SKILLS_SERVICE,
} from "../src/plugins/first-party/service-keys";
import { createRuntimeServiceKey, RuntimeServiceRegistry } from "../src/runtime/services";
import { createTestConfig } from "./helpers/config";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("RuntimeServiceRegistry", () => {
  test("binds typed internal collaborators and clears stale assemblies", () => {
    const key = createRuntimeServiceKey<{ value: number }>("test");
    const services = new RuntimeServiceRegistry();

    services.bind(key, { value: 42 });
    expect(services.require(key, "test").value).toBe(42);

    services.clear();
    expect(services.get(key)).toBeUndefined();
  });

  test("the default bootstrap shares its first-party service assembly", async () => {
    const root = mkdtempSync(join(tmpdir(), "sloppy-runtime-services-"));
    roots.push(root);
    const config = createTestConfig({
      plugins: {
        skills: {
          enabled: true,
          builtinSkillsDir: join(root, "builtin-skills"),
          skillsDir: join(root, "skills"),
        },
        messaging: { enabled: true },
        delegation: { enabled: true },
      },
    });

    const runtime = await bootstrapProviderRuntime({ config });
    try {
      expect(runtime.runtimeCtx.services.get(SKILLS_SERVICE)).toBeDefined();
      expect(runtime.runtimeCtx.services.get(MESSAGING_SERVICE)).toBeDefined();
      expect(runtime.runtimeCtx.services.get(DELEGATION_SERVICE)).toBeDefined();
    } finally {
      runtime.hub.shutdown();
    }
  });
});
