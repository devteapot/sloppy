import { describe, expect, test } from "bun:test";

import { defaultConfigPromise } from "../src/config/load";
import { buildSystemPrompt } from "../src/core/context";

const BASE_CONFIG = await defaultConfigPromise;

describe("buildSystemPrompt", () => {
  test("returns base prompt when called with no config", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("You are Sloppy");
    expect(prompt).not.toContain("Orchestrator mode");
  });

  test("returns base prompt when orchestratorMode is disabled", () => {
    const prompt = buildSystemPrompt(BASE_CONFIG);
    expect(prompt).toContain("You are Sloppy");
    expect(prompt).not.toContain("Orchestrator mode");
  });

  test("appends orchestrator section when orchestratorMode is enabled", () => {
    const config = {
      ...BASE_CONFIG,
      agent: { ...BASE_CONFIG.agent, orchestratorMode: true },
    };
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain("You are Sloppy");
    expect(prompt).toContain("Orchestrator mode");
    expect(prompt).toContain("create_plan");
    expect(prompt).toContain("spawn_agent");
    expect(prompt).toContain("Delegation rule");
  });
});
