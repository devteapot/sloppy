import { lstatSync, unlinkSync } from "node:fs";

export function unlinkOwnedSocketPath(socketPath: string | undefined): void {
  if (!socketPath) {
    return;
  }
  try {
    if (lstatSync(socketPath).isSocket()) {
      unlinkSync(socketPath);
    }
  } catch {
    // Best-effort cleanup for managed TUI subprocess sockets. The session
    // server also unlinks on graceful shutdown; this covers interrupted TUI
    // exits where the child may not finish before the terminal process ends.
  }
}
