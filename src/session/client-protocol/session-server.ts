import type { SessionRuntime } from "../runtime";
import { listenClientProtocol } from "./rpc-server";
import {
  CLIENT_PROTOCOL_VERSION,
  type SaveLlmProfileInput,
  SESSION_CLIENT_PROTOCOL,
  type SessionClientSnapshot,
} from "./types";

function requiredString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function approvalMode(params: Record<string, unknown>): "normal" | "auto" {
  const mode = requiredString(params, "mode");
  if (mode !== "normal" && mode !== "auto") {
    throw new Error("mode must be 'normal' or 'auto'.");
  }
  return mode;
}

export function listenSessionClientProtocol(
  runtime: SessionRuntime,
  socketPath: string,
): { close(): void } {
  return listenClientProtocol<SessionClientSnapshot>({
    socketPath,
    protocol: SESSION_CLIENT_PROTOCOL,
    version: CLIENT_PROTOCOL_VERSION,
    snapshot: () => runtime.getClientSnapshot(),
    subscribe: (listener) => runtime.store.onChange(() => listener()),
    onConnect: (owner) => runtime.store.registerClient(`client-${connectionId(owner)}`),
    onDisconnect: (owner) => runtime.store.unregisterClient(`client-${connectionId(owner)}`),
    handleRequest: async (_owner, method, params) => {
      switch (method) {
        case "session.sendMessage":
          return runtime.sendMessage(requiredString(params, "text"));
        case "turn.cancel":
          return runtime.cancelTurn();
        case "queue.cancel":
          return runtime.cancelQueuedMessage(requiredString(params, "queuedMessageId"));
        case "approval.setMode":
          return runtime.setApprovalMode(approvalMode(params));
        case "approval.approve":
          return runtime.approveApproval(requiredString(params, "approvalId"));
        case "approval.reject":
          return runtime.rejectApproval(
            requiredString(params, "approvalId"),
            typeof params.reason === "string" ? params.reason : undefined,
          );
        case "task.cancel":
          return runtime.cancelTask(requiredString(params, "taskId"));
        case "llm.saveProfile": {
          const input = optionalRecord(params.input) as SaveLlmProfileInput | undefined;
          return runtime.saveLlmProfile({
            ...(input?.profileId && { profile_id: input.profileId }),
            ...(input?.label && { label: input.label }),
            ...(input?.kind && { kind: input.kind }),
            ...(input?.endpointId && { endpoint_id: input.endpointId }),
            ...(input?.model && { model: input.model }),
            ...(input?.reasoningEffort && { reasoning_effort: input.reasoningEffort }),
            ...(input?.thinkingEnabled !== undefined && {
              thinking_enabled: input.thinkingEnabled,
            }),
            ...(input?.thinkingDisplay && { thinking_display: input.thinkingDisplay }),
            ...(input?.adapterId && { adapter_id: input.adapterId }),
            ...(input?.apiKey && { api_key: input.apiKey }),
            ...(input?.makeDefault !== undefined && { make_default: input.makeDefault }),
          });
        }
        case "llm.setDefaultProfile":
          return runtime.setDefaultLlmProfile(requiredString(params, "profileId"));
        case "llm.deleteProfile":
          return runtime.deleteLlmProfile(requiredString(params, "profileId"));
        case "llm.deleteApiKey":
          return runtime.deleteLlmApiKey(requiredString(params, "profileId"));
        case "config.reload":
          return runtime.reloadConfig();
        case "plugin.invoke":
          return runtime.invokePluginClientCommand(
            requiredString(params, "pluginId"),
            requiredString(params, "command"),
            optionalRecord(params.params),
          );
        case "provider.query":
          return runtime.queryProviderState(
            requiredString(params, "providerId"),
            requiredString(params, "path"),
            {
              depth: typeof params.depth === "number" ? params.depth : undefined,
              maxNodes: typeof params.maxNodes === "number" ? params.maxNodes : undefined,
              window:
                Array.isArray(params.window) && params.window.length === 2
                  ? [Number(params.window[0]), Number(params.window[1])]
                  : undefined,
            },
          );
        case "provider.invoke":
          return runtime.invokeProviderAction(
            requiredString(params, "providerId"),
            requiredString(params, "path"),
            requiredString(params, "action"),
            optionalRecord(params.params),
          );
        case "provider.load":
          return runtime.loadProvider(requiredString(params, "providerId"));
        case "provider.unload":
          return runtime.unloadProvider(requiredString(params, "providerId"));
        case "provider.reload":
          return runtime.reloadProvider(requiredString(params, "providerId"));
        default:
          throw new Error(`Unknown session client method: ${method}`);
      }
    },
  });
}

const ownerIds = new WeakMap<object, string>();
function connectionId(owner: object): string {
  let id = ownerIds.get(owner);
  if (!id) {
    id = crypto.randomUUID();
    ownerIds.set(owner, id);
  }
  return id;
}
