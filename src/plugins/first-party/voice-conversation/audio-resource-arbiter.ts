import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type AudioResourceOwner = {
  sessionId: string;
  runId: string;
};

export type AudioResourceLeaseState = AudioResourceOwner & {
  resourceKey: string;
  leaseId: string;
  pid: number;
  acquiredAt: string;
};

export interface AudioResourceLease {
  readonly id: string;
  readonly resources: readonly string[];
  release(): Promise<void>;
}

export class AudioResourceBusyError extends Error {
  readonly code = "audio_resource_busy";

  constructor(
    readonly resourceKey: string,
    readonly owner: AudioResourceLeaseState,
  ) {
    super(
      `Audio resource '${resourceKey}' is leased by session ${owner.sessionId} run ${owner.runId}.`,
    );
    this.name = "AudioResourceBusyError";
  }
}

type ProcessOwner = { pid: number; processIdentity?: string };
type LockOwner = AudioResourceLeaseState & { token: string; processIdentity?: string };
type GuardOwner = ProcessOwner & { token: string; createdAt: string };

export type AudioResourceArbiterOptions = {
  lockRoot?: string;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  processIdentity?: (pid: number) => string | null;
  now?: () => Date;
  retryDelayMs?: number;
  guardTimeoutMs?: number;
  pollIntervalMs?: number;
};

type SharedRoot = {
  tail: Promise<void>;
  listeners: Set<() => void>;
  errorListeners: Set<(error: unknown) => void>;
};

const sharedRoots = new Map<string, SharedRoot>();

/**
 * Exclusive audio-resource ownership shared by every Session in this process
 * and, through atomic lock directories, by other Sloppy processes on the host.
 * Lock records contain ownership metadata only; audio bytes never enter State.
 */
export class AudioResourceArbiter {
  readonly lockRoot: string;

  private readonly pid: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly processIdentity: (pid: number) => string | null;
  private readonly ownerProcessIdentity: string | undefined;
  private readonly now: () => Date;
  private readonly retryDelayMs: number;
  private readonly guardTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly shared: SharedRoot;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private subscriptionCount = 0;
  private lastObservedFingerprint: string | null = null;

  constructor(options: AudioResourceArbiterOptions = {}) {
    const userSuffix = typeof process.getuid === "function" ? `-${process.getuid()}` : "";
    this.lockRoot = resolve(
      options.lockRoot ?? join(tmpdir(), `sloppy-audio-resources${userSuffix}`),
    );
    this.pid = options.pid ?? process.pid;
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.processIdentity = options.processIdentity ?? readProcessIdentity;
    this.ownerProcessIdentity = this.processIdentity(this.pid) ?? undefined;
    this.now = options.now ?? (() => new Date());
    this.retryDelayMs = options.retryDelayMs ?? 10;
    this.guardTimeoutMs = options.guardTimeoutMs ?? 5000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.shared = sharedRoot(this.lockRoot);
  }

  subscribe(listener: () => void): () => void {
    this.shared.listeners.add(listener);
    this.subscriptionCount += 1;
    this.startPolling();
    return () => {
      this.shared.listeners.delete(listener);
      this.subscriptionCount = Math.max(0, this.subscriptionCount - 1);
      if (this.subscriptionCount === 0 && this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    };
  }

  subscribeErrors(listener: (error: unknown) => void): () => void {
    this.shared.errorListeners.add(listener);
    return () => this.shared.errorListeners.delete(listener);
  }

  async acquire(
    owner: AudioResourceOwner,
    resourceKeys: readonly string[],
  ): Promise<AudioResourceLease> {
    const resources = normalizeResourceKeys(resourceKeys);
    if (resources.length === 0) {
      throw new Error("At least one audio resource key is required.");
    }

    return this.withLocalLock(async () => {
      const guard = await this.acquireGuard();
      const leaseId = `audio-lease-${randomUUID()}`;
      const token = randomUUID();
      const acquiredAt = this.now().toISOString();
      const created: string[] = [];
      try {
        for (const resourceKey of resources) {
          const path = this.resourceLockPath(resourceKey);
          const existing = await this.readResourceOwner(path);
          if (existing) {
            if (this.ownerIsLive(existing)) {
              throw new AudioResourceBusyError(resourceKey, toLeaseState(existing));
            }
            await rm(path, { recursive: true, force: true });
          }

          const record: LockOwner = {
            resourceKey,
            leaseId,
            sessionId: owner.sessionId,
            runId: owner.runId,
            pid: this.pid,
            processIdentity: this.ownerProcessIdentity,
            acquiredAt,
            token,
          };
          if (!(await installLockDirectory(path, record))) {
            const raced = await this.readResourceOwner(path);
            if (raced) {
              throw new AudioResourceBusyError(resourceKey, toLeaseState(raced));
            }
            throw new Error(`Audio resource lock at ${path} has no readable owner.`);
          }
          created.push(path);
        }
      } catch (error) {
        const rollbackErrors = await removePaths(created);
        let guardError: unknown;
        try {
          await this.releaseGuard(guard);
        } catch (releaseError) {
          guardError = releaseError;
        }
        if (rollbackErrors.length > 0 || guardError) {
          throw new AggregateError(
            [error, ...rollbackErrors, ...(guardError ? [guardError] : [])],
            "Audio resource acquisition and rollback failed.",
          );
        }
        throw error;
      }
      try {
        await this.releaseGuard(guard);
      } catch (error) {
        const rollbackErrors = await removePaths(created);
        let guardRetryError: unknown;
        try {
          await this.releaseGuard(guard);
        } catch (releaseError) {
          guardRetryError = releaseError;
        }
        if (rollbackErrors.length > 0 || guardRetryError) {
          throw new AggregateError(
            [error, ...rollbackErrors, ...(guardRetryError ? [guardRetryError] : [])],
            "Audio resource ownership handoff and rollback failed.",
          );
        }
        throw error;
      }

      this.emitChange();
      let released = false;
      let releasePromise: Promise<void> | null = null;
      return {
        id: leaseId,
        resources,
        release: async () => {
          if (released) return;
          if (!releasePromise) {
            releasePromise = this.withLocalLock(async () => {
              const releaseGuard = await this.acquireGuard();
              try {
                for (const resourceKey of resources) {
                  const path = this.resourceLockPath(resourceKey);
                  const current = await this.readResourceOwner(path);
                  if (current?.leaseId === leaseId && current.token === token) {
                    await rm(path, { recursive: true, force: true });
                  }
                }
              } finally {
                await this.releaseGuard(releaseGuard);
              }
            })
              .then(() => {
                released = true;
                this.emitChange();
              })
              .finally(() => {
                if (!released) {
                  releasePromise = null;
                }
              });
          }
          await releasePromise;
        },
      };
    });
  }

  async state(): Promise<AudioResourceLeaseState[]> {
    return this.withLocalLock(async () => {
      const guard = await this.acquireGuard();
      try {
        const entries = await readdir(this.lockRoot, { withFileTypes: true }).catch(() => []);
        const state: AudioResourceLeaseState[] = [];
        for (const entry of entries) {
          if (
            !entry.isDirectory() ||
            !entry.name.startsWith("resource-") ||
            !entry.name.endsWith(".lock")
          ) {
            continue;
          }
          const path = join(this.lockRoot, entry.name);
          const owner = await this.readResourceOwner(path);
          if (!owner) continue;
          if (!this.ownerIsLive(owner)) {
            await rm(path, { recursive: true, force: true });
            continue;
          }
          state.push(toLeaseState(owner));
        }
        return state.sort((left, right) => left.resourceKey.localeCompare(right.resourceKey));
      } finally {
        await this.releaseGuard(guard);
      }
    });
  }

  private async withLocalLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.shared.tail;
    let unlock!: () => void;
    this.shared.tail = new Promise<void>((resolveUnlock) => {
      unlock = resolveUnlock;
    });
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
    }
  }

  private async acquireGuard(): Promise<GuardOwner> {
    await this.ensureLockRoot();
    const path = this.guardPath();
    const deadline = Date.now() + this.guardTimeoutMs;
    while (true) {
      const guard: GuardOwner = {
        pid: this.pid,
        processIdentity: this.ownerProcessIdentity,
        token: randomUUID(),
        createdAt: this.now().toISOString(),
      };
      if (await installLockDirectory(path, guard)) {
        return guard;
      }
      const current = await readJson<GuardOwner>(join(path, "owner.json"));
      if (current && this.guardBelongsToCurrentProcess(current)) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (current && !this.ownerIsLive(current)) {
        const tombstone = `${path}.stale-${randomUUID()}`;
        try {
          await rename(path, tombstone);
          await rm(tombstone, { recursive: true, force: true });
          continue;
        } catch (renameError) {
          if (!isNotFound(renameError)) throw renameError;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring audio resource arbiter guard at ${path}.`);
      }
      await delay(this.retryDelayMs);
    }
  }

  private async releaseGuard(owner: GuardOwner): Promise<void> {
    const path = this.guardPath();
    const current = await readJson<GuardOwner>(join(path, "owner.json"));
    if (current?.token === owner.token) {
      await rm(path, { recursive: true, force: true });
    }
  }

  private guardBelongsToCurrentProcess(owner: ProcessOwner): boolean {
    if (owner.pid !== this.pid) {
      return false;
    }
    if (!owner.processIdentity || !this.ownerProcessIdentity) {
      return true;
    }
    return owner.processIdentity === this.ownerProcessIdentity;
  }

  private async readResourceOwner(path: string): Promise<LockOwner | null> {
    return readJson<LockOwner>(join(path, "owner.json"));
  }

  private guardPath(): string {
    return join(this.lockRoot, "arbiter.lock");
  }

  private async ensureLockRoot(): Promise<void> {
    await mkdir(this.lockRoot, { recursive: true, mode: 0o700 });
    const handle = await open(
      this.lockRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isDirectory()) {
        throw new Error(`Audio resource lock root is not a directory: ${this.lockRoot}`);
      }
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
        throw new Error(`Audio resource lock root is owned by another user: ${this.lockRoot}`);
      }
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  }

  private resourceLockPath(resourceKey: string): string {
    const hash = createHash("sha256").update(resourceKey).digest("hex");
    return join(this.lockRoot, `resource-${hash}.lock`);
  }

  private emitChange(): void {
    for (const listener of this.shared.listeners) {
      try {
        listener();
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private reportError(error: unknown): void {
    for (const listener of this.shared.errorListeners) {
      try {
        listener(error);
      } catch {
        // Diagnostics must never affect ownership operations.
      }
    }
  }

  private ownerIsLive(owner: ProcessOwner): boolean {
    if (!this.isProcessAlive(owner.pid)) {
      return false;
    }
    if (!owner.processIdentity) {
      return true;
    }
    const currentIdentity = this.processIdentity(owner.pid);
    return currentIdentity === null || currentIdentity === owner.processIdentity;
  }

  private startPolling(): void {
    if (this.pollTimer || this.pollIntervalMs <= 0) {
      return;
    }
    this.pollTimer = setInterval(() => {
      if (this.pollInFlight) {
        return;
      }
      this.pollInFlight = true;
      void this.state()
        .then((state) => {
          const fingerprint = JSON.stringify(state);
          if (
            this.lastObservedFingerprint === null ||
            fingerprint !== this.lastObservedFingerprint
          ) {
            this.emitChange();
          }
          this.lastObservedFingerprint = fingerprint;
        })
        .catch((error: unknown) => this.reportError(error))
        .finally(() => {
          this.pollInFlight = false;
        });
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }
}

async function removePaths(paths: readonly string[]): Promise<unknown[]> {
  const results = await Promise.allSettled(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

function sharedRoot(root: string): SharedRoot {
  let shared = sharedRoots.get(root);
  if (!shared) {
    shared = { tail: Promise.resolve(), listeners: new Set(), errorListeners: new Set() };
    sharedRoots.set(root, shared);
  }
  return shared;
}

function normalizeResourceKeys(resourceKeys: readonly string[]): string[] {
  return [...new Set(resourceKeys.map((key) => key.trim()).filter(Boolean))].sort();
}

function toLeaseState(owner: LockOwner): AudioResourceLeaseState {
  return {
    resourceKey: owner.resourceKey,
    leaseId: owner.leaseId,
    sessionId: owner.sessionId,
    runId: owner.runId,
    pid: owner.pid,
    acquiredAt: owner.acquiredAt,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
}

async function installLockDirectory(path: string, owner: unknown): Promise<boolean> {
  const candidate = `${path}.candidate-${randomUUID()}`;
  await mkdir(candidate);
  try {
    await writeJson(join(candidate, "owner.json"), owner);
    try {
      await rename(candidate, path);
      return true;
    } catch (error) {
      if (isAlreadyExists(error) || (error as NodeJS.ErrnoException).code === "ENOTEMPTY") {
        return false;
      }
      throw error;
    }
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readProcessIdentity(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
      const fieldsAfterCommand = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fieldsAfterCommand[19] ?? null;
    }
    return (
      execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
