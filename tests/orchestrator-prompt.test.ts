import { describe, expect, test } from "bun:test";

import { defaultConfigPromise } from "../src/config/load";
import { buildSystemPrompt } from "../src/core/context";
import { orchestratorSystemPromptFragment } from "../src/runtime/orchestration";

const BASE_CONFIG = await defaultConfigPromise;

describe("buildSystemPrompt", () => {
  test("returns base prompt when called with no config", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("You are Sloppy");
    expect(prompt).not.toContain("Orchestrator mode");
  });

  test("returns base prompt when no fragments are provided", () => {
    const prompt = buildSystemPrompt(BASE_CONFIG);
    expect(prompt).toContain("You are Sloppy");
    expect(prompt).not.toContain("Orchestrator mode");
  });

  test("appends fragments when provided", () => {
    const fragment = orchestratorSystemPromptFragment();
    const prompt = buildSystemPrompt(BASE_CONFIG, [fragment]);
    expect(prompt).toContain("You are Sloppy");
    expect(prompt).toContain("Orchestrator mode");
    expect(prompt).toContain("create_plan");
    expect(prompt).toContain("spawn_agent");
    expect(prompt).toContain("Delegation rule");
    expect(prompt).toContain("/specs");
    expect(prompt).toContain("/findings");
    expect(prompt).toContain("spec_refs");
    expect(prompt).toContain("blocking findings");
    expect(prompt).toContain("Model only true blocking dependencies");
    expect(prompt).toContain("Do not add a dependency just because two workers share data flow");
    expect(prompt).toContain("scaffold -> {data-model, ui} -> {docs, verification}");
    expect(prompt).toContain("scoped work packet");
    expect(prompt).toContain("decision_request");
    expect(prompt).toContain("unblock: true");
    expect(prompt).toContain("do not edit files directly");
  });
});
