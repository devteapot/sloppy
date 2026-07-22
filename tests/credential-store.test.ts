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
  test("threads cancellation into credential command reads", async () => {
    const controller = new AbortController();
    let calls = 0;
    const runner: CommandRunner = async (_command, _args, options) => {
      calls += 1;
      if (calls === 1) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return new Promise<CommandResult>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    };
    const store = createCredentialStore(runner);
    const reason = new Error("credential read cancelled");
    const reading = store.get("profile-c", { signal: controller.signal });
    controller.abort(reason);

    await expect(reading).rejects.toBe(reason);
    expect(calls).toBeGreaterThan(0);
  });

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

  test("fails secure when keytar is not installed (no argv fallback)", async () => {
    if (process.platform !== "darwin") {
      return;
    }

    __resetKeytarCacheForTests(Promise.resolve(null));

    const { runner, calls } = captureRunner();
    const store = createCredentialStore(runner);
    await expect(store.set("profile-b", "fallback-secret")).rejects.toThrow(/keytar/);

    expect(
      calls.some(
        (call) => call.command === "security" && call.args.includes("add-generic-password"),
      ),
    ).toBe(false);
  });
});
