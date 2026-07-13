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
            selected_session_id: stringParam(params, "selectedSessionId"),
            label: stringParam(params, "label"),
          });
        case "lease.update":
          return supervisor.updateClientLease(owner, {
            selected_session_id: stringParam(params, "selectedSessionId"),
            label: stringParam(params, "label"),
          });
        case "lease.unregister":
          return supervisor.unregisterClientLease(owner);
        case "session.create":
          return supervisor.publicSessionRecord(
            await supervisor.createSession(
              sessionScopeInputFromParams({
                workspace_id: params.workspaceId,
                project_id: params.projectId,
                title: params.title,
                session_id: params.sessionId,
                approval_mode: params.approvalMode,
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
                workspace_id: workspaceId,
                project_id: stringParam(params, "projectId"),
                title: stringParam(params, "title"),
                session_id: stringParam(params, "sessionId"),
                approval_mode: approvalModeParam(
                  { approval_mode: params.approvalMode },
                  "approval_mode",
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
