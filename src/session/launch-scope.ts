import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export type LaunchScope = {
  key: string;
  root: string;
};

export function resolveLaunchScope(cwd = process.cwd()): LaunchScope {
  const root = realpathSync(resolve(cwd));
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return { key, root };
}

export function runtimeRoot(): string {
  const override = process.env.SLOPPY_RUNTIME_DIR;
  if (override && override.trim().length > 0) {
    return resolve(override);
  }
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && xdg.trim().length > 0) {
    return join(xdg, "sloppy");
  }
  const tmp = process.env.TMPDIR;
  if (tmp && tmp.trim().length > 0) {
    return join(tmp, "sloppy");
  }
  return "/tmp/slop";
}

export function supervisorRuntimePaths(scope: LaunchScope): {
  root: string;
  socketPath: string;
  discoveryPath: string;
  logPath: string;
} {
  const root = join(runtimeRoot(), "supervisors");
  return {
    root,
    socketPath: join(root, `supervisor-${scope.key}.sock`),
    discoveryPath: join(root, `supervisor-${scope.key}.json`),
    logPath: join(root, `supervisor-${scope.key}.log`),
  };
}

export function ensureRuntimeRoot(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function assertRemovableSocketPath(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  if (!lstatSync(path).isSocket()) {
    throw new Error(`Refusing to replace non-socket file at ${path}.`);
  }
}
