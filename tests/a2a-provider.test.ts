import { afterEach, describe, expect, test } from "bun:test";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { type A2AAgentConfig, A2AProvider } from "../src/providers/builtin/a2a";
import { InProcessTransport } from "../src/providers/builtin/in-process";

type A2AFetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
};

const providers: A2AProvider[] = [];

afterEach(() => {
  while (providers.length > 0) {
    providers.pop()?.stop();
  }
});

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function createProvider(options: {
  agents: Record<string, A2AAgentConfig>;
  card: Record<string, unknown>;
}) {
  const calls: A2AFetchCall[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.href : String(input);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({
      url,
      method,
      headers: headersToRecord(headers),
      body,
    });

    if (method === "GET") {
      return new Response(JSON.stringify(options.card), {
        status: 200,
        headers: {
          "content-type": "application/json",
          etag: '"agent-card-v1"',
        },
      });
    }

    const rpcMethod = String(body?.method ?? "");
    switch (rpcMethod) {
      case "SendMessage": {
        const params = body?.params as { message?: { contextId?: string; taskId?: string } };
        return Response.json({
          jsonrpc: "2.0",
          id: body?.id,
          result: {
            task: {
              id: params.message?.taskId ?? "task-1",
              contextId: params.message?.contextId ?? "ctx-1",
              status: {
                state: "TASK_STATE_WORKING",
                timestamp: "2026-05-06T10:00:00.000Z",
              },
              artifacts: [],
            },
          },
        });
      }
      case "GetTask":
        return Response.json({
          jsonrpc: "2.0",
          id: body?.id,
          result: {
            task: {
              id: "task-1",
              contextId: "ctx-1",
              status: {
                state: "TASK_STATE_COMPLETED",
                timestamp: "2026-05-06T10:01:00.000Z",
              },
              artifacts: [{ artifactId: "artifact-1", parts: [{ text: "done" }] }],
            },
          },
        });
      case "ListTasks":
        return Response.json({
          jsonrpc: "2.0",
          id: body?.id,
          result: {
            tasks: [
              {
                id: "task-2",
                contextId: "ctx-1",
                status: {
                  state: "TASK_STATE_INPUT_REQUIRED",
                  timestamp: "2026-05-06T10:02:00.000Z",
                },
              },
            ],
            nextPageToken: "",
            pageSize: 50,
            totalSize: 1,
          },
        });
      case "CancelTask":
        return Response.json({
          jsonrpc: "2.0",
          id: body?.id,
          result: {
            task: {
              id: "task-1",
              contextId: "ctx-1",
              status: {
                state: "TASK_STATE_CANCELED",
                timestamp: "2026-05-06T10:03:00.000Z",
              },
            },
          },
        });
      case "GetExtendedAgentCard":
        return Response.json({
          jsonrpc: "2.0",
          id: body?.id,
          result: {
            ...options.card,
            skills: [
              ...(Array.isArray(options.card.skills) ? options.card.skills : []),
              {
                id: "extended-skill",
                name: "Extended Skill",
                description: "Only visible after authentication.",
                tags: ["extended"],
              },
            ],
          },
        });
      default:
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body?.id,
            error: {
              code: -32601,
              message: `Unknown method: ${rpcMethod}`,
            },
          },
          { status: 200 },
        );
    }
  };

  const provider = new A2AProvider({
    agents: options.agents,
    fetchOnStart: false,
    fetchImpl,
  });
  providers.push(provider);
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));
  return { provider, consumer, calls };
}

describe("A2AProvider", () => {
  test("projects Agent Cards, skills, and JSON-RPC task lifecycle into SLOP state", async () => {
    const { consumer, calls } = createProvider({
      agents: {
        planner: {
          cardUrl: "https://agent.example/.well-known/agent-card.json",
          timeoutMs: 5000,
        },
      },
      card: {
        name: "Planner Agent",
        description: "Plans work for other agents.",
        version: "1.0.0",
        supportedInterfaces: [
          {
            url: "https://agent.example/a2a/rpc",
            protocolBinding: "JSONRPC",
            protocolVersion: "1.0",
          },
        ],
        capabilities: {
          streaming: true,
          pushNotifications: false,
          extendedAgentCard: true,
        },
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
        skills: [
          {
            id: "plan",
            name: "Plan",
            description: "Create a project plan.",
            tags: ["planning"],
            examples: ["Plan a release."],
          },
        ],
      },
    });

    await consumer.connect();

    const initial = await consumer.query("/session", 2);
    expect(initial.properties?.agent_count).toBe(1);
    expect(initial.properties?.ready_count).toBe(0);

    const refresh = await consumer.invoke("/agents/planner", "refresh_card", {});
    expect(refresh.status).toBe("ok");

    const agent = await consumer.query("/agents/planner", 2);
    expect(agent.properties?.status).toBe("ready");
    expect(agent.properties?.interface_url).toBe("https://agent.example/a2a/rpc");
    expect(agent.properties?.skill_count).toBe(1);

    const skills = await consumer.query("/agents/planner/skills", 2);
    expect(skills.children?.map((child) => child.id)).toEqual(["plan"]);

    const send = await consumer.invoke("/agents/planner", "send_message", {
      text: "Draft the release plan.",
      accepted_output_modes: ["text/plain"],
      return_immediately: true,
    });
    expect(send.status).toBe("ok");
    expect(send.data).toMatchObject({
      agent_id: "planner",
      task_id: "task-1",
      context_id: "ctx-1",
    });

    const sendCall = calls.find((call) => call.body?.method === "SendMessage");
    expect(sendCall?.url).toBe("https://agent.example/a2a/rpc");
    expect(sendCall?.headers["a2a-version"]).toBe("1.0");
    expect(sendCall?.body?.params).toMatchObject({
      message: {
        role: "ROLE_USER",
        parts: [{ text: "Draft the release plan." }],
      },
      configuration: {
        acceptedOutputModes: ["text/plain"],
        returnImmediately: true,
      },
    });

    const tasks = await consumer.query("/tasks", 2);
    expect(tasks.properties?.count).toBe(1);
    expect(tasks.children?.[0]?.properties?.status_state).toBe("TASK_STATE_WORKING");

    const taskRefresh = await consumer.invoke("/tasks/planner%3Atask-1", "refresh", {});
    expect(taskRefresh.status).toBe("ok");
    const refreshedTask = await consumer.query("/tasks/planner%3Atask-1", 1);
    expect(refreshedTask.properties?.status_state).toBe("TASK_STATE_COMPLETED");
    expect(refreshedTask.properties?.artifact_count).toBe(1);

    const list = await consumer.invoke("/agents/planner", "list_tasks", {
      context_id: "ctx-1",
      include_artifacts: false,
    });
    expect(list.status).toBe("ok");
    const updatedTasks = await consumer.query("/tasks", 2);
    expect(updatedTasks.properties?.count).toBe(2);
    expect(updatedTasks.properties?.active_count).toBe(1);

    const followup = await consumer.invoke("/agents/planner/tasks/task-1", "send_followup", {
      text: "Continue with risks.",
    });
    expect(followup.status).toBe("ok");
    const followupCall = calls.filter((call) => call.body?.method === "SendMessage").at(-1);
    expect(followupCall?.body?.params).toMatchObject({
      message: {
        taskId: "task-1",
        contextId: "ctx-1",
        parts: [{ text: "Continue with risks." }],
      },
    });

    const cancel = await consumer.invoke("/agents/planner/tasks/task-1", "cancel", {});
    expect(cancel.status).toBe("ok");
    const canceledTask = await consumer.query("/tasks/planner%3Atask-1", 1);
    expect(canceledTask.properties?.status_state).toBe("TASK_STATE_CANCELED");

    const extended = await consumer.invoke("/agents/planner", "get_extended_card", {});
    expect(extended.status).toBe("ok");
    const extendedSkills = await consumer.query("/agents/planner/skills", 2);
    expect(extendedSkills.children?.map((child) => child.id)).toEqual(["plan", "extended-skill"]);
  });

  test("reports agents without a supported JSON-RPC interface as provider state errors", async () => {
    const { consumer } = createProvider({
      agents: {
        restOnly: {
          cardUrl: "https://agent.example/.well-known/agent-card.json",
        },
      },
      card: {
        name: "REST Agent",
        description: "Only exposes REST.",
        version: "1.0.0",
        supportedInterfaces: [
          {
            url: "https://agent.example/a2a/rest",
            protocolBinding: "HTTP+JSON",
            protocolVersion: "1.0",
          },
        ],
        capabilities: {},
        skills: [],
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
      },
    });

    await consumer.connect();

    const refresh = await consumer.invoke("/agents/restOnly", "refresh_card", {});
    expect(refresh.status).toBe("error");

    const agent = await consumer.query("/agents/restOnly", 1);
    expect(agent.properties?.status).toBe("error");
    expect(String(agent.properties?.error)).toContain("does not expose a JSONRPC interface");
  });
});
