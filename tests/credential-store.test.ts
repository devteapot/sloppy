import { afterEach, describe, expect, test } from "bun:test";

import {
  __resetKeytarCacheForTests,
  type CommandResult,
  type CommandRunner,
  createCredentialStore,
} from "../src/llm/credential-store";

type RunnerCall = { command: string; args: string[] };

function captureRunner(): { runner: CommandRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    return { stdout: "", stderr: "", exitCode: 0 } satisfies CommandResult;
  };
  return { runner, calls };
}

afterEach(() => {
  __resetKeytarCacheForTests(null);
});

describe("KeychainCredentialStore", () => {
  test("uses keytar when available so the secret stays out of argv", async () => {
    if (process.platform !== "darwin") {
      return;
    }

    const setCalls: Array<{ service: string; account: string; password: string }> = [];
    __resetKeytarCacheForTests(
      Promise.resolve({
        setPassword: async (service, account, password) => {
          setCalls.push({ service, account, password });
        },
        getPassword: async () => null,
        deletePassword: async () => true,
      }),
    );

    const { runner, calls } = captureRunner();
    const store = createCredentialStore(runner);
    await store.set("profile-a", "super-secret");

    expect(setCalls).toEqual([
      { service: "devteapot.sloppy.llm", account: "profile-a", password: "super-secret" },
    ]);
    expect(
      calls.some(
        (call) => call.command === "security" && call.args.includes("add-generic-password"),
      ),
    ).toBe(false);
  });

  test("falls back to security when keytar is not installed", async () => {
    if (process.platform !== "darwin") {
      return;
    }

    __resetKeytarCacheForTests(Promise.resolve(null));

    const { runner, calls } = captureRunner();
    const store = createCredentialStore(runner);
    await store.set("profile-b", "fallback-secret");

    const writeCall = calls.find(
      (call) => call.command === "security" && call.args.includes("add-generic-password"),
    );
    expect(writeCall).toBeDefined();
    // Document the known argv exposure: the fallback path *does* place the
    // secret into argv. This assertion exists so that if the fallback ever
    // changes shape, the test forces a deliberate update.
    expect(writeCall?.args).toContain("fallback-secret");
  });
});
