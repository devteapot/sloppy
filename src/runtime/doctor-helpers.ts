import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";

export async function assertDirectory(path: string, label: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      return `${label} is not a directory: ${path}`;
    }
    return null;
  } catch (error) {
    return `${label} is not readable as a directory at ${path}: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

export function expandDoctorCommandTemplate(value: string): string {
  return value.replaceAll("{model}", "");
}

function commandHasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function resolveCommandPath(command: string, cwd: string): string {
  return isAbsolute(command) ? command : resolve(cwd, command);
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findExecutable(command: string, cwd: string): Promise<string | null> {
  if (commandHasPathSeparator(command)) {
    const path = resolveCommandPath(command, cwd);
    return (await isExecutable(path)) ? path : null;
  }

  const pathEntries = (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const pathEntry of pathEntries) {
    const candidate = resolve(pathEntry, command);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}
