import { lstatSync, unlinkSync } from "node:fs";

export type UnixListener = {
  close: () => void;
};

export function unlinkSocketPath(socketPath: string): void {
  try {
    if (lstatSync(socketPath).isSocket()) {
      unlinkSync(socketPath);
    }
  } catch {
    // Best-effort cleanup. A listener implementation may already unlink, or
    // the process may be shutting down after the path disappeared.
  }
}

export function closeUnixListener(
  listener: UnixListener | null | undefined,
  socketPath: string,
): void {
  try {
    listener?.close();
  } catch {
    // Closing is best-effort during shutdown; removing stale sockets matters
    // more for the next managed TUI/session start.
  } finally {
    unlinkSocketPath(socketPath);
  }
}
