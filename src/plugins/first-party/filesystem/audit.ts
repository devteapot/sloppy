import type { AgentToolInvocation } from "../../../core/agent";
import type { ToolEventEnricher } from "../../../session/event-bus";

export const filesystemToolEventEnricher: ToolEventEnricher = (invocation: AgentToolInvocation) => {
  if (invocation.providerId !== "filesystem") {
    return null;
  }
  const params = invocation.params ?? {};
  const path = typeof params.path === "string" ? params.path : undefined;
  const opMap: Record<string, string> = {
    read: "read",
    write: "write",
    edit: "write",
    edit_range: "write",
    mkdir: "mkdir",
    search: "search",
    set_focus: "focus",
    focus: "focus",
  };
  const op = opMap[invocation.action];
  if (!op) {
    return null;
  }
  return {
    file: { op, path },
  };
};
