import { describe, expect, test } from "bun:test";

import { ConversationHistory } from "../src/core/history";

describe("ConversationHistory", () => {
  test("retains complete turns until the loop performs semantic compaction", () => {
    const history = new ConversationHistory({ historyTurns: 1, toolResultMaxChars: 1_000 });
    history.addUserText("first user");
    history.addAssistantContent([{ type: "text", text: "first assistant" }]);
    history.addUserText("second user");
    history.addAssistantContent([{ type: "text", text: "second assistant" }]);

    expect(history.buildRequestMessages("current state")).toEqual([
      { role: "user", content: [{ type: "text", text: "first user" }] },
      { role: "assistant", content: [{ type: "text", text: "first assistant" }] },
      { role: "user", content: [{ type: "text", text: "second user" }] },
      { role: "assistant", content: [{ type: "text", text: "second assistant" }] },
      { role: "user", content: [{ type: "text", text: "current state" }] },
    ]);
  });

  test("completes every tool call in a cancelled batch while preserving resolved results", () => {
    const history = new ConversationHistory({ historyTurns: 2, toolResultMaxChars: 1_000 });
    history.addUserText("run the batch");
    history.addAssistantContent([
      { type: "tool_use", id: "call-1", name: "first", input: {} },
      { type: "tool_use", id: "call-2", name: "second", input: {} },
      { type: "tool_use", id: "call-3", name: "third", input: {} },
    ]);

    history.addToolBatchResults(
      [
        { type: "tool_use", id: "call-1", name: "first", input: {} },
        { type: "tool_use", id: "call-2", name: "second", input: {} },
        { type: "tool_use", id: "call-3", name: "third", input: {} },
      ],
      [
        { type: "tool_result", toolUseId: "call-3", content: "deferred result" },
        { type: "tool_result", toolUseId: "call-1", content: "completed result" },
      ],
      { content: "cancelled", isError: true },
    );

    expect(history.buildRequestMessages("current state")[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "call-1", content: "completed result" },
        { type: "tool_result", toolUseId: "call-2", content: "cancelled", isError: true },
        { type: "tool_result", toolUseId: "call-3", content: "deferred result" },
      ],
    });
  });
});
