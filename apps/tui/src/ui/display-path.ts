import { homedir } from "node:os";

export function formatHomePath(path: string, homePath = homedir()): string {
  const home = trimTrailingSlash(homePath);
  if (!path || !home || home === "/") {
    return path;
  }

  const comparablePath = trimTrailingSlash(path);
  if (comparablePath === home) {
    return "~";
  }
  if (path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}
