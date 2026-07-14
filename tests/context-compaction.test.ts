import { describe, expect, test } from "bun:test";

import { compactConversationHistory, selectFirstRetainedIndex } from "../src/core/compaction";
import { ConsumerHub } from "../src/core/consumer";
import { ConversationHistory } from "../src/core/history";
import { runLoop } from "../src/core/loop";
import type { LlmAdapter, LlmChatOptions, LlmResponse } from "../src/llm/types";
import { LlmContextOverflowError } from "../src/llm/types";
import { createTestConfig } from "./helpers/config";

class SummaryLlm implements LlmAdapter {
  readonly requests: LlmChatOptions[] = [];

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    this.requests.push(structuredClone(options));
    return {
      content: [{ type: "text", text: "Preserved requirements and completed work." }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

class OverflowRecoveryLlm implements LlmAdapter {
  normalCalls = 0;
  summaryPrompts: string[] = [];
  retriedMessages = "";

  async chat(options: LlmChatOptions): Promise<LlmResponse> {
    if (options.system.includes("compact conversation history")) {
      this.summaryPrompts.push(JSON.stringify(options.messages));
      return {
        content: [{ type: "text", text: "The first request was completed." }],
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 5 },
      };
    }

    this.normalCalls += 1;
    if (this.normalCalls === 1) {
      throw new Error("maximum context length exceeded for this model");
    }
    this.retriedMessages = JSON.stringify(options.messages);
    return {
      content: [{ type: "text", text: "recovered" }],
      stopReason: "end_turn",
      usage: { inputTokens: 30, outputTokens: 4 },
    };
  }
}

describe("conversation context compaction", () => {
  test("summarizes discarded turns without retaining an orphaned assistant prefix", async () => {
    const config = createTestConfig({ agent: { historyTurns: 2 } });
    const history = new ConversationHistory({
      historyTurns: config.agent.historyTurns,
      toolResultMaxChars: config.agent.toolResultMaxChars,
    });
    for (let turn = 1; turn <= 3; turn += 1) {
      history.addUserText(`user ${turn}`);
      history.addAssistantContent([{ type: "text", text: `assistant ${turn}` }]);
    }

    const llm = new SummaryLlm();
    const result = await compactConversationHistory({
      history,
      llm,
      config,
      estimatedTokensBefore: 100,
    });

    expect(result.compacted).toBe(true);
    const snapshot = history.snapshot();
    expect(snapshot.archive).toHaveLength(6);
    expect(snapshot.active[0]?.kind).toBe("summary");
    expect(snapshot.active[1]?.kind).toBe("user");
    expect(JSON.stringify(snapshot.active[1]?.message)).toContain("user 2");
    expect(history.buildRequestMessages("STATE")[0]?.role).toBe("user");
  });

  test("never selects a tool result as a split-turn retention boundary", () => {
    const config = createTestConfig();
    const history = new ConversationHistory({
      historyTurns: config.agent.historyTurns,
      toolResultMaxChars: config.agent.toolResultMaxChars,
    });
    history.addUserText("large turn");
    for (let index = 0; index < 4; index += 1) {
      history.addAssistantContent([
        { type: "tool_use", id: `call-${index}`, name: "read", input: { index } },
      ]);
      history.addToolResults([
        { type: "tool_result", toolUseId: `call-${index}`, content: "x".repeat(2000) },
      ]);
    }
    history.addAssistantContent([{ type: "text", text: "done" }]);

    const entries = history.activeEntries();
    const firstRetainedIndex = selectFirstRetainedIndex({
      entries,
      maxTurns: 8,
      keepRecentTokens: 600,
    });

    expect(firstRetainedIndex).toBeGreaterThan(0);
    expect(entries[firstRetainedIndex]?.kind).toBe("assistant");
    expect(entries[firstRetainedIndex]?.kind).not.toBe("tool");
  });

  test("repairs unresolved tool calls when an interrupted session is restored", () => {
    const config = createTestConfig();
    const history = new ConversationHistory({
      historyTurns: config.agent.historyTurns,
      toolResultMaxChars: config.agent.toolResultMaxChars,
    });
    history.addUserText("run the check");
    history.addAssistantContent([
      { type: "tool_use", id: "interrupted-call", name: "check", input: {} },
    ]);

    history.recoverInterruptedTurn();

    const snapshot = history.snapshot();
    expect(snapshot.active.map((entry) => entry.kind)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(JSON.stringify(snapshot.active[2]?.message)).toContain("interrupted-call");
    expect(JSON.stringify(snapshot.active[2]?.message)).toContain('"isError":true');
    expect(JSON.stringify(snapshot.active[3]?.message)).toContain("Runtime recovery");
  });

  test("normalizes overflow, compacts once, retries, and excludes live state from summaries", async () => {
    const config = createTestConfig({
      agent: {
        historyTurns: 99,
        contextCompaction: {
          enabled: true,
          reserveTokens: 1024,
          keepRecentTokens: 2048,
          summaryMaxTokens: 512,
          retryOnOverflow: true,
        },
      },
    });
    const history = new ConversationHistory({
      historyTurns: config.agent.historyTurns,
      toolResultMaxChars: config.agent.toolResultMaxChars,
    });
    history.addUserText("first request");
    history.addAssistantContent([{ type: "text", text: "first result" }]);
    history.addUserText("continue");
    const llm = new OverflowRecoveryLlm();
    const hub = new ConsumerHub([], config);

    try {
      await hub.connect();
      const result = await runLoop({ config, hub, history, llm });

      expect(result).toMatchObject({ status: "completed", response: "recovered" });
      expect(llm.normalCalls).toBe(2);
      expect(llm.summaryPrompts).toHaveLength(1);
      expect(llm.summaryPrompts[0]).not.toContain("<slop-state");
      expect(llm.retriedMessages).toContain("<slop-state");
      expect(history.snapshot().compactions).toHaveLength(1);
    } finally {
      hub.shutdown();
    }
  });

  test("does not retry when compaction cannot reduce an irreducible request", async () => {
    const config = createTestConfig({ agent: { historyTurns: 99 } });
    const history = new ConversationHistory({
      historyTurns: config.agent.historyTurns,
      toolResultMaxChars: config.agent.toolResultMaxChars,
    });
    history.addUserText("only request");
    const llm: LlmAdapter = {
      chat: async () => {
        throw new LlmContextOverflowError();
      },
    };
    const hub = new ConsumerHub([], config);

    try {
      await hub.connect();
      await expect(runLoop({ config, hub, history, llm })).rejects.toBeInstanceOf(
        LlmContextOverflowError,
      );
    } finally {
      hub.shutdown();
    }
  });

  test("rejects an irreducible oversized request before calling the provider", async () => {
    const config = createTestConfig({ agent: { historyTurns: 99 } });
    const history = new ConversationHistory({
      historyTurns: config.agent.historyTurns,
      toolResultMaxChars: config.agent.toolResultMaxChars,
    });
    history.addUserText("x".repeat(4000));
    let providerCalls = 0;
    const llm: LlmAdapter = {
      chat: async () => {
        providerCalls += 1;
        return {
          content: [{ type: "text", text: "unexpected" }],
          stopReason: "end_turn",
          usage: {},
        };
      },
    };
    const hub = new ConsumerHub([], config);

    try {
      await hub.connect();
      await expect(
        runLoop({ config, hub, history, llm, contextWindowTokens: 1000 }),
      ).rejects.toThrow("after compaction");
      expect(providerCalls).toBe(0);
    } finally {
      hub.shutdown();
    }
  });
});
