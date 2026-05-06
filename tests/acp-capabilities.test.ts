import { describe, expect, test } from "bun:test";

import type { SloppyConfig } from "../src/config/schema";
import { LlmConfigurationError } from "../src/llm/profile-manager";
import { assertAcpSpawnAllowed } from "../src/runtime/delegation/acp-capabilities";

type AcpAdapterConfig = NonNullable<
  NonNullable<SloppyConfig["providers"]["delegation"]["acp"]>["adapters"][string]
>;

const fullCapabilities = {
  spawn_allowed: true,
  shell_allowed: true,
  network_allowed: true,
  filesystem_reads_allowed: true,
  filesystem_writes_allowed: true,
};

function adapter(capabilities?: AcpAdapterConfig["capabilities"]): AcpAdapterConfig {
  return {
    command: ["fake-acp"],
    ...(capabilities ? { capabilities } : {}),
  };
}

describe("assertAcpSpawnAllowed", () => {
  test("rejects routed ACP spawns when the adapter has no capabilities declaration", () => {
    expect(() =>
      assertAcpSpawnAllowed({
        adapterId: "fake",
        adapter: adapter(),
        routeEnvelope: { id: "route-1" },
      }),
    ).toThrow(LlmConfigurationError);
  });

  test("allows direct deny-only ACP spawns without an adapter capabilities declaration", () => {
    expect(() =>
      assertAcpSpawnAllowed({
        adapterId: "fake",
        adapter: adapter(),
        capabilityMasks: [
          {
            id: "no-terminal",
            provider: "terminal",
            mode: "deny",
          },
        ],
      }),
    ).not.toThrow();
  });

  test("rejects filesystem write allow masks when the adapter is read-only", () => {
    expect(() =>
      assertAcpSpawnAllowed({
        adapterId: "fake",
        adapter: adapter({
          ...fullCapabilities,
          filesystem_writes_allowed: false,
        }),
        capabilityMasks: [
          {
            id: "workspace-write",
            provider: "filesystem",
            actions: ["write"],
            mode: "allow",
          },
        ],
      }),
    ).toThrow(/filesystem_writes_allowed/);
  });

  test("allows terminal allow masks when shell capability is declared", () => {
    expect(() =>
      assertAcpSpawnAllowed({
        adapterId: "fake",
        adapter: adapter(fullCapabilities),
        capabilityMasks: [
          {
            id: "terminal-only",
            provider: "terminal",
            actions: ["execute"],
            mode: "allow",
          },
        ],
      }),
    ).not.toThrow();
  });

  test("treats routed spawns without allow masks as broad child access", () => {
    expect(() =>
      assertAcpSpawnAllowed({
        adapterId: "fake",
        adapter: adapter({
          ...fullCapabilities,
          network_allowed: false,
        }),
        routeEnvelope: { id: "route-1" },
      }),
    ).toThrow(/network_allowed/);
  });
});
