import { lstatSync, unlinkSync } from "node:fs";

export function unlinkSocketPath(socketPath: string): void {
  try {
    if (lstatSync(socketPath).isSocket()) {
      unlinkSync(socketPath);
    }
  } catch {
    // The listener may already have removed the socket during shutdown.
  }
}
