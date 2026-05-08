import { resolve } from "node:path";

import { isWithinRoot, safeRealpath } from "../../../providers/path-containment";
import { assertDirectory } from "../../../runtime/doctor-helpers";
import type { RuntimeDoctorCheck, RuntimeDoctorContext } from "../../../runtime/doctor-types";

export async function checkWorkspacePaths({
  config,
  workspaceRoot,
}: RuntimeDoctorContext): Promise<RuntimeDoctorCheck> {
  const filesystemRoot = resolve(workspaceRoot, config.plugins.filesystem.root);
  const terminalCwd = resolve(workspaceRoot, config.plugins.terminal.cwd);
  const errors: string[] = [];

  const filesystemError = await assertDirectory(filesystemRoot, "Filesystem root");
  if (filesystemError) {
    errors.push(filesystemError);
  }

  if (config.plugins.terminal.enabled) {
    const terminalError = await assertDirectory(terminalCwd, "Terminal cwd");
    if (terminalError) {
      errors.push(terminalError);
    }

    const realFilesystemRoot = safeRealpath(filesystemRoot);
    if (!filesystemError && !terminalError && realFilesystemRoot) {
      if (!isWithinRoot(realFilesystemRoot, terminalCwd)) {
        errors.push(
          `Terminal cwd must stay inside the filesystem root. cwd=${terminalCwd} root=${filesystemRoot}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    return {
      id: "workspace-paths",
      status: "error",
      summary: `${errors.length} workspace path check(s) failed.`,
      detail: errors.join("\n"),
    };
  }

  return {
    id: "workspace-paths",
    status: "ok",
    summary: config.plugins.terminal.enabled
      ? `Filesystem root and terminal cwd are usable at ${filesystemRoot}.`
      : `Filesystem root is usable at ${filesystemRoot}.`,
    detail: config.plugins.terminal.enabled ? `terminal_cwd=${terminalCwd}` : undefined,
  };
}
