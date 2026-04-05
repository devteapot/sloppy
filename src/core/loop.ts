import { formatTree } from "@slop-ai/consumer/browser";

import type { SloppyConfig } from "../config/schema";
import type { LlmAdapter, ToolResultContentBlock, ToolUseContentBlock } from "../llm/types";
import type { ConsumerHub } from "./consumer";
import { buildStateContext, buildSystemPrompt } from "./context";
import type { ConversationHistory } from "./history";
import type { RuntimeToolSet } from "./tools";

type ToolResult = {
  block: ToolResultContentBlock;
  summary: string;
};

function stringifyResult(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

async function executeToolCall(
  toolUse: ToolUseContentBlock,
  toolSet: RuntimeToolSet,
  hub: ConsumerHub,
  config: SloppyConfig,
): Promise<ToolResult> {
  const resolution = toolSet.resolve(toolUse.name);
  if (!resolution) {
    return {
      block: {
        type: "tool_result",
        toolUseId: toolUse.id,
        isError: true,
        content: `Unknown tool: ${toolUse.name}`,
      },
      summary: `unknown ${toolUse.name}`,
    };
  }

  try {
    if (resolution.kind === "observation") {
      if (resolution.action === "query_state") {
        const providerId = String(toolUse.input.provider ?? "");
        const path = String(toolUse.input.path ?? "/");
        const depth = typeof toolUse.input.depth === "number" ? toolUse.input.depth : 2;
        const maxNodes =
          typeof toolUse.input.max_nodes === "number" ? toolUse.input.max_nodes : undefined;
        const minSalience =
          typeof toolUse.input.min_salience === "number" ? toolUse.input.min_salience : undefined;
        const windowOffset =
          typeof toolUse.input.window_offset === "number" ? toolUse.input.window_offset : undefined;
        const windowCount =
          typeof toolUse.input.window_count === "number" ? toolUse.input.window_count : undefined;
        const tree = await hub.queryState({
          providerId,
          path,
          depth,
          maxNodes,
          minSalience,
          window:
            windowOffset != null && windowCount != null ? [windowOffset, windowCount] : undefined,
        });

        return {
          block: {
            type: "tool_result",
            toolUseId: toolUse.id,
            content: `Queried ${providerId}${path}\n\n${formatTree(tree)}`,
          },
          summary: `query ${providerId}${path}`,
        };
      }

      const providerId = String(toolUse.input.provider ?? "");
      const path = String(toolUse.input.path ?? "/");
      const depth =
        typeof toolUse.input.depth === "number" ? toolUse.input.depth : config.agent.detailDepth;
      const maxNodes =
        typeof toolUse.input.max_nodes === "number"
          ? toolUse.input.max_nodes
          : config.agent.detailMaxNodes;
      const tree = await hub.focusState({
        providerId,
        path,
        depth,
        maxNodes,
      });

      return {
        block: {
          type: "tool_result",
          toolUseId: toolUse.id,
          content: `Focused ${providerId}${path}\n\n${formatTree(tree)}`,
        },
        summary: `focus ${providerId}${path}`,
      };
    }

    const rawInput = { ...toolUse.input };
    let path = resolution.path;
    if (path == null) {
      const target = rawInput.target;
      if (typeof target !== "string" || target.length === 0) {
        throw new Error(`Grouped affordance ${toolUse.name} requires a target path.`);
      }
      path = target;
      delete rawInput.target;
    }

    const result = await hub.invoke(resolution.providerId, path, resolution.action, rawInput);
    if (result.status === "accepted") {
      await hub
        .focusState({
          providerId: resolution.providerId,
          path: "/tasks",
          depth: 2,
          maxNodes: config.agent.detailMaxNodes,
        })
        .catch(() => undefined);
    }

    return {
      block: {
        type: "tool_result",
        toolUseId: toolUse.id,
        isError: result.status === "error",
        content: stringifyResult(result),
      },
      summary: `${resolution.providerId}:${resolution.action} ${path}`,
    };
  } catch (error) {
    return {
      block: {
        type: "tool_result",
        toolUseId: toolUse.id,
        isError: true,
        content: error instanceof Error ? error.message : String(error),
      },
      summary: `error ${toolUse.name}`,
    };
  }
}

export async function runLoop(options: {
  config: SloppyConfig;
  hub: ConsumerHub;
  history: ConversationHistory;
  llm: LlmAdapter;
  onText?: (chunk: string) => void;
  onToolCall?: (summary: string) => void;
  onToolResult?: (summary: string) => void;
}): Promise<string> {
  const system = buildSystemPrompt();

  for (let iteration = 0; iteration < options.config.agent.maxIterations; iteration += 1) {
    const stateContext = buildStateContext(options.hub.getProviderViews(), options.config);
    const toolSet = options.hub.getRuntimeToolSet();
    const response = await options.llm.chat({
      system,
      messages: options.history.buildRequestMessages(stateContext),
      tools: toolSet.tools,
      maxTokens: options.config.llm.maxTokens,
      onText: options.onText,
    });

    options.history.addAssistantContent(response.content);

    const toolCalls = response.content.filter(
      (block): block is ToolUseContentBlock => block.type === "tool_use",
    );
    if (toolCalls.length === 0 || response.stopReason !== "tool_use") {
      return options.history.latestAssistantText();
    }

    const toolResults: ToolResultContentBlock[] = [];
    for (const toolCall of toolCalls) {
      options.onToolCall?.(`${toolCall.name} ${JSON.stringify(toolCall.input)}`);
      const result = await executeToolCall(toolCall, toolSet, options.hub, options.config);
      options.onToolResult?.(result.summary);
      toolResults.push(result.block);
    }

    options.history.addToolResults(toolResults);
  }

  throw new Error(`Exceeded max iterations (${options.config.agent.maxIterations}).`);
}
