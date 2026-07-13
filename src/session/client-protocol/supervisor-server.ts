import type { SessionSupervisor } from "../supervisor";
import { approvalModeParam, sessionScopeInputFromParams, stringParam } from "../supervisor-model";
import { listenClientProtocol } from "./rpc-server";
import {
  CLIENT_PROTOCOL_VERSION,
  SUPERVISOR_CLIENT_PROTOCOL,
  type SupervisorClientSnapshot,
} from "./types";

export function listenSupervisorClientProtocol(
  supervisor: SessionSupervisor,
  socketPath: string,
): { close(): void } {
  return listenClientProtocol<SupervisorClientSnapshot>({
    socketPath,
    protocol: SUPERVISOR_CLIENT_PROTOCOL,
    version: CLIENT_PROTOCOL_VERSION,
    snapshot: () => supervisor.getClientSnapshot(),
    subscribe: (listener) => supervisor.onLifecycleChange(listener),
    onDisconnect: (owner) => supervisor.removeConnection(owner),
    handleRequest: async (owner, method, params) => {
      switch (method) {
        case "supervisor.snapshot":
          return supervisor.getClientSnapshot();
        case "lease.register":
          return supervisor.registerClientLease(owner, {
            selectedSessionId: stringParam(params, "selectedSessionId"),
            label: stringParam(params, "label"),
          });
        case "lease.update":
          return supervisor.updateClientLease(owner, {
            selectedSessionId: stringParam(params, "selectedSessionId"),
            label: stringParam(params, "label"),
          });
        case "lease.unregister":
          return supervisor.unregisterClientLease(owner);
        case "session.create":
          return supervisor.publicSessionRecord(
            await supervisor.createSession(
              sessionScopeInputFromParams({
                workspaceId: params.workspaceId,
                projectId: params.projectId,
                title: params.title,
                sessionId: params.sessionId,
                approvalMode: params.approvalMode,
              }),
              owner,
            ),
          );
        case "session.select": {
          const sessionId = stringParam(params, "sessionId");
          if (!sessionId) throw new Error("sessionId is required.");
          return supervisor.publicSessionRecord(await supervisor.selectSession(sessionId, owner));
        }
        case "session.stop": {
          const sessionId = stringParam(params, "sessionId");
          if (!sessionId) throw new Error("sessionId is required.");
          return supervisor.stopSession(sessionId, owner);
        }
        case "config.reload":
          return supervisor.reloadConfig();
        case "scope.createSession": {
          const workspaceId = stringParam(params, "workspaceId");
          if (!workspaceId) throw new Error("workspaceId is required.");
          return supervisor.publicSessionRecord(
            await supervisor.createSession(
              {
                workspaceId,
                projectId: stringParam(params, "projectId"),
                title: stringParam(params, "title"),
                sessionId: stringParam(params, "sessionId"),
                approvalMode: approvalModeParam(
                  { approvalMode: params.approvalMode },
                  "approvalMode",
                ),
              },
              owner,
            ),
          );
        }
        default:
          throw new Error(`Unknown supervisor client method: ${method}`);
      }
    },
  });
}
