import type { CliRenderer, Renderable } from "@opentui/core";

export function isRenderableFocused(
  renderer: CliRenderer,
  target: Renderable | undefined,
): boolean {
  return Boolean(target && renderer.currentFocusedRenderable === target);
}
