import type { CliRenderer } from "@opentui/core";

export type CopyResult = "copied" | "unsupported" | "error";

export function copyToClipboard(renderer: CliRenderer, text: string): CopyResult {
  try {
    if (!renderer.isOsc52Supported()) {
      return "unsupported";
    }
    return renderer.copyToClipboardOSC52(text) ? "copied" : "error";
  } catch {
    return "error";
  }
}
