import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AudioResourceArbiter, AudioResourceBusyError } from "./audio-resource-arbiter";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function lockRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sloppy-audio-arbiter-test-"));
  roots.push(root);
  return root;
}

describe("AudioResourceArbiter", () => {
  test("hardens the shared lock root to the current user", async () => {
    const root = await lockRoot();
    await chmod(root, 0o777);
    const arbiter = new AudioResourceArbiter({ lockRoot: root });
    const lease = await arbiter.acquire({ sessionId: "session", runId: "run" }, ["speaker"]);

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    await lease.release();
  });

  test("atomically excludes another Session and exposes metadata-only state", async () => {
    const root = await lockRoot();
    const first = new AudioResourceArbiter({ lockRoot: root });
    const second = new AudioResourceArbiter({ lockRoot: root });
    const lease = await first.acquire({ sessionId: "session-a", runId: "run-a" }, [
      "host:default:output",
      "host:default:input",
    ]);

    let conflict: unknown;
    try {
      await second.acquire({ sessionId: "session-b", runId: "run-b" }, ["host:default:input"]);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(AudioResourceBusyError);
    expect(conflict).toMatchObject({
      code: "audio_resource_busy",
      resourceKey: "host:default:input",
      owner: { sessionId: "session-a", runId: "run-a" },
    });

    const state = await second.state();
    expect(state).toHaveLength(2);
    expect(state.map((item) => item.resourceKey)).toEqual([
      "host:default:input",
      "host:default:output",
    ]);
    expect(JSON.stringify(state)).not.toContain("audioBase64");
    expect(JSON.stringify(state)).not.toContain("pcm");

    await lease.release();
    await lease.release();
    expect(await first.state()).toEqual([]);
  });

  test("rolls back every resource when an atomic acquisition conflicts", async () => {
    const root = await lockRoot();
    const first = new AudioResourceArbiter({ lockRoot: root });
    const second = new AudioResourceArbiter({ lockRoot: root });
    const lease = await first.acquire({ sessionId: "owner", runId: "one" }, ["resource:b"]);

    await expect(
      second.acquire({ sessionId: "waiter", runId: "two" }, ["resource:a", "resource:b"]),
    ).rejects.toBeInstanceOf(AudioResourceBusyError);

    expect((await second.state()).map((item) => item.resourceKey)).toEqual(["resource:b"]);
    await lease.release();
  });

  test("reclaims a resource only when its owning process is stale", async () => {
    const root = await lockRoot();
    const livePids = new Set([101]);
    const first = new AudioResourceArbiter({
      lockRoot: root,
      pid: 101,
      isProcessAlive: (pid) => livePids.has(pid),
    });
    const lease = await first.acquire({ sessionId: "dead-session", runId: "dead-run" }, ["mic"]);

    livePids.delete(101);
    livePids.add(202);
    const second = new AudioResourceArbiter({
      lockRoot: root,
      pid: 202,
      isProcessAlive: (pid) => livePids.has(pid),
    });
    const replacement = await second.acquire({ sessionId: "new-session", runId: "new-run" }, [
      "mic",
    ]);

    expect(await second.state()).toMatchObject([
      { resourceKey: "mic", sessionId: "new-session", runId: "new-run", pid: 202 },
    ]);
    await lease.release();
    expect(await second.state()).toHaveLength(1);
    await replacement.release();
  });

  test("reclaims an abandoned lock after PID reuse", async () => {
    const root = await lockRoot();
    const first = new AudioResourceArbiter({
      lockRoot: root,
      pid: 101,
      isProcessAlive: () => true,
      processIdentity: () => "process-start-a",
    });
    const abandoned = await first.acquire({ sessionId: "old", runId: "old-run" }, ["mic"]);
    const replacementOwner = new AudioResourceArbiter({
      lockRoot: root,
      pid: 101,
      isProcessAlive: () => true,
      processIdentity: () => "process-start-b",
    });

    const replacement = await replacementOwner.acquire({ sessionId: "new", runId: "new-run" }, [
      "mic",
    ]);
    expect(await replacementOwner.state()).toMatchObject([{ sessionId: "new", runId: "new-run" }]);
    await abandoned.release();
    await replacement.release();
  });

  test("notifies in-process observers after acquire and release", async () => {
    const root = await lockRoot();
    const arbiter = new AudioResourceArbiter({ lockRoot: root });
    let changes = 0;
    const unsubscribe = arbiter.subscribe(() => {
      changes += 1;
    });

    const lease = await arbiter.acquire({ sessionId: "session", runId: "run" }, ["speaker"]);
    await lease.release();
    unsubscribe();

    expect(changes).toBe(2);
  });

  test("observer failures never orphan an acquired lease", async () => {
    const root = await lockRoot();
    const arbiter = new AudioResourceArbiter({ lockRoot: root });
    const errors: unknown[] = [];
    arbiter.subscribeErrors((error) => errors.push(error));
    arbiter.subscribe(() => {
      throw new Error("observer failed");
    });

    const lease = await arbiter.acquire({ sessionId: "session", runId: "run" }, ["speaker"]);
    expect(errors).toHaveLength(1);
    await lease.release();
    expect(await arbiter.state()).toEqual([]);
  });

  test("rolls back installed resource locks when guard handoff fails", async () => {
    const root = await lockRoot();
    const arbiter = new AudioResourceArbiter({ lockRoot: root });
    const mutable = arbiter as unknown as {
      releaseGuard(owner: unknown): Promise<void>;
    };
    const releaseGuard = mutable.releaseGuard.bind(arbiter);
    let failOnce = true;
    mutable.releaseGuard = async (owner) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("guard handoff failed");
      }
      await releaseGuard(owner);
    };

    await expect(
      arbiter.acquire({ sessionId: "session", runId: "run" }, ["microphone"]),
    ).rejects.toThrow("guard handoff failed");
    expect(await arbiter.state()).toEqual([]);
  });

  test("recovers a same-process guard after transient cleanup failure", async () => {
    const root = await lockRoot();
    const arbiter = new AudioResourceArbiter({ lockRoot: root });
    const mutable = arbiter as unknown as {
      releaseGuard(owner: unknown): Promise<void>;
    };
    const releaseGuard = mutable.releaseGuard.bind(arbiter);
    let failOnce = true;
    mutable.releaseGuard = async (owner) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("transient guard cleanup failure");
      }
      await releaseGuard(owner);
    };

    await expect(arbiter.state()).rejects.toThrow("transient guard cleanup failure");
    expect(await arbiter.state()).toEqual([]);
  });

  test("polling failures are reported without unhandled rejection", async () => {
    const parent = await lockRoot();
    const invalidRoot = join(parent, "not-a-directory");
    await writeFile(invalidRoot, "blocked");
    const arbiter = new AudioResourceArbiter({ lockRoot: invalidRoot, pollIntervalMs: 5 });
    const errors: unknown[] = [];
    const unsubscribeError = arbiter.subscribeErrors((error) => errors.push(error));
    const unsubscribe = arbiter.subscribe(() => undefined);

    await Bun.sleep(20);

    unsubscribe();
    unsubscribeError();
    expect(errors.length).toBeGreaterThan(0);
  });

  test("coalesces polling while an observation is still in flight", async () => {
    const root = await lockRoot();
    const arbiter = new AudioResourceArbiter({ lockRoot: root, pollIntervalMs: 5 });
    const observation = Promise.withResolvers<void>();
    let calls = 0;
    const mutable = arbiter as unknown as {
      state(): Promise<[]>;
    };
    mutable.state = async () => {
      calls += 1;
      await observation.promise;
      return [];
    };
    const unsubscribe = arbiter.subscribe(() => undefined);

    await Bun.sleep(25);
    expect(calls).toBe(1);
    unsubscribe();
    observation.resolve();
    await Bun.sleep(0);
    expect(calls).toBe(1);
  });

  test("a failed release remains retryable", async () => {
    const root = await lockRoot();
    const blockingPid = process.pid + 1000000;
    const arbiter = new AudioResourceArbiter({
      lockRoot: root,
      guardTimeoutMs: 10,
      retryDelayMs: 1,
      isProcessAlive: (pid) => pid === process.pid || pid === blockingPid,
    });
    const lease = await arbiter.acquire({ sessionId: "session", runId: "run" }, ["speaker"]);
    const guard = join(root, "arbiter.lock");
    await mkdir(guard);
    await writeFile(
      join(guard, "owner.json"),
      `${JSON.stringify({ pid: blockingPid, token: "held", createdAt: new Date().toISOString() })}\n`,
    );

    await expect(lease.release()).rejects.toThrow("Timed out acquiring");
    await rm(guard, { recursive: true, force: true });
    await lease.release();

    expect(await arbiter.state()).toEqual([]);
  });

  test("lease release recovers after its guard cleanup fails", async () => {
    const root = await lockRoot();
    const arbiter = new AudioResourceArbiter({ lockRoot: root });
    const lease = await arbiter.acquire({ sessionId: "session", runId: "run" }, ["speaker"]);
    const mutable = arbiter as unknown as {
      releaseGuard(owner: unknown): Promise<void>;
    };
    const releaseGuard = mutable.releaseGuard.bind(arbiter);
    let failOnce = true;
    mutable.releaseGuard = async (owner) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("release guard cleanup failed");
      }
      await releaseGuard(owner);
    };

    await expect(lease.release()).rejects.toThrow("release guard cleanup failed");
    await lease.release();
    expect(await arbiter.state()).toEqual([]);
  });

  test("polls ownership changes made outside this process", async () => {
    const root = await lockRoot();
    const arbiter = new AudioResourceArbiter({ lockRoot: root, pollIntervalMs: 10 });
    let changes = 0;
    const unsubscribe = arbiter.subscribe(() => {
      changes += 1;
    });
    await Bun.sleep(25);

    const resourceKey = "external:microphone";
    const hash = createHash("sha256").update(resourceKey).digest("hex");
    const path = join(root, `resource-${hash}.lock`);
    await mkdir(path);
    await writeFile(
      join(path, "owner.json"),
      `${JSON.stringify({
        resourceKey,
        leaseId: "external-lease",
        sessionId: "external-session",
        runId: "external-run",
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        token: "external-token",
      })}\n`,
    );
    await Bun.sleep(35);

    unsubscribe();
    expect(changes).toBeGreaterThan(0);
  });
});
