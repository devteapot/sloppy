import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeHomeLlmConfig } from "../src/config/persist";
import type { LlmConfig } from "../src/config/schema";

const originalHome = process.env.HOME;

afterEach(() => {
  process.env.HOME = originalHome;
});

function llmConfig(): LlmConfig {
  return {
    reasoningEffort: "medium",
    thinking: { enabled: false, display: "visible" },
    endpoints: {},
    defaultProfileId: "openai-main",
    profiles: [
      {
        kind: "native",
        id: "openai-main",
        label: "OpenAI Main",
        endpointId: "openai",
        model: "gpt-5.4",
      },
    ],
  } as unknown as LlmConfig;
}

describe("writeHomeLlmConfig", () => {
  test("preserves comments and unrelated sections in the home config", async () => {
    const home = await mkdtemp(join(tmpdir(), "sloppy-persist-home-"));
    process.env.HOME = home;
    await mkdir(join(home, ".sloppy"), { recursive: true });
    const configPath = join(home, ".sloppy", "config.yaml");
    await writeFile(
      configPath,
      [
        "# Top-of-file comment the user wrote by hand.",
        "plugins:",
        "  terminal:",
        "    # Keep the terminal sandboxed to the repo.",
        "    enabled: true",
        "llm:",
        "  defaultProfileId: stale-profile",
        "",
      ].join("\n"),
      "utf8",
    );

    await writeHomeLlmConfig(llmConfig());

    const written = await readFile(configPath, "utf8");
    expect(written).toContain("# Top-of-file comment the user wrote by hand.");
    expect(written).toContain("# Keep the terminal sandboxed to the repo.");
    expect(written).toContain("enabled: true");
    expect(written).toContain("defaultProfileId: openai-main");
    expect(written).not.toContain("stale-profile");
  });

  test("creates the config file when none exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "sloppy-persist-fresh-"));
    process.env.HOME = home;

    await writeHomeLlmConfig(llmConfig());

    const written = await readFile(join(home, ".sloppy", "config.yaml"), "utf8");
    expect(written).toContain("defaultProfileId: openai-main");
  });

  test("refuses to clobber a config file with invalid YAML", async () => {
    const home = await mkdtemp(join(tmpdir(), "sloppy-persist-bad-"));
    process.env.HOME = home;
    await mkdir(join(home, ".sloppy"), { recursive: true });
    const configPath = join(home, ".sloppy", "config.yaml");
    const broken = "plugins: [unclosed";
    await writeFile(configPath, broken, "utf8");

    await expect(writeHomeLlmConfig(llmConfig())).rejects.toThrow("failed to parse");
    expect(await readFile(configPath, "utf8")).toBe(broken);
  });
});
