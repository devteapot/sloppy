import { relative } from "node:path";

import type { FileViewCoverage } from "./model";

export const TEXT_DECODER = new TextDecoder();
export const TEXT_ENCODER = new TextEncoder();

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars - 16)}\n...[truncated]`;
}

export function detectLineEnding(text: string): "\n" | "\r\n" {
  const crlfCount = text.match(/\r\n/g)?.length ?? 0;
  if (crlfCount === 0) {
    return "\n";
  }
  const lfCount = (text.match(/\n/g)?.length ?? 0) - crlfCount;
  return crlfCount >= lfCount ? "\r\n" : "\n";
}

export function splitTextLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function isProbablyBinary(content: Uint8Array): boolean {
  const sample = content.subarray(0, 1024);
  return sample.includes(0);
}

export function relativePath(root: string, target: string): string {
  const rel = relative(root, target);
  return rel || ".";
}

export function entryIdForPath(path: string): string {
  return path.replace(/[^a-zA-Z0-9_.-]+/g, "__") || "root";
}

export function displayNameForPath(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export function viewIdForPath(
  path: string,
  version: number,
  coverage: FileViewCoverage,
  range?: { startLine?: number; endLine?: number },
): string {
  const base = entryIdForPath(path);
  if (coverage === "full") {
    return `${base}__v${version}`;
  }
  if (coverage === "preview") {
    return `${base}__v${version}__preview`;
  }
  return `${base}__v${version}__L${range?.startLine ?? 1}-L${range?.endLine ?? "end"}`;
}
