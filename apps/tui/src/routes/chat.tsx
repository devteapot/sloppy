import { TextAttributes } from "@opentui/core";
import { For, Show } from "solid-js";
import {
  collapseTurnTools,
  InlineApprovalCard,
  InlineTaskCard,
  InlineToolLine,
  type ToolEntry,
} from "../components/inline-cards";
import { MessageRow } from "../components/transcript";
import { COLORS } from "../lib/theme";
import type { SessionViewSnapshot, TranscriptMessage } from "../slop/types";
import type { Verbosity } from "../state/verbosity";

type FlowItem =
  | { kind: "message"; message: TranscriptMessage }
  | { kind: "tools"; turnId: string; tools: ToolEntry[]; collapsed: boolean };

function buildFlow(snapshot: SessionViewSnapshot, verbosity: Verbosity): FlowItem[] {
  if (verbosity === "compact") {
    return snapshot.transcript.map((message) => ({ kind: "message", message }) as const);
  }
  // Interleave tool calls with messages by turn: each turn renders as
  //   [user message, …tool calls for turn, assistant message]
  // We attach a turn's tool list right BEFORE its assistant message (or at
  // the end of that turn's slice if the assistant hasn't materialized yet).
  const items: FlowItem[] = [];
  const lastAssistantIndexByTurn = new Map<string, number>();
  for (let i = 0; i < snapshot.transcript.length; i += 1) {
    const message = snapshot.transcript[i];
    if (message.role === "assistant" && message.turnId) {
      lastAssistantIndexByTurn.set(message.turnId, i);
    }
  }

  const activeTurnId = snapshot.turn.turnId;
  const turnIdsSeen = new Set<string>();
  for (let i = 0; i < snapshot.transcript.length; i += 1) {
    const message = snapshot.transcript[i];
    const turnId = message.turnId;
    if (
      message.role === "assistant" &&
      turnId &&
      lastAssistantIndexByTurn.get(turnId) === i &&
      !turnIdsSeen.has(turnId)
    ) {
      const tools = collapseTurnTools(snapshot.activity, turnId);
      if (tools.length > 0) {
        const collapsed = verbosity !== "verbose" && turnId !== activeTurnId;
        items.push({ kind: "tools", turnId, tools, collapsed });
      }
      turnIdsSeen.add(turnId);
    }
    items.push({ kind: "message", message });
  }

  // Active turn whose assistant message hasn't streamed yet — append tool
  // calls after the user message that started this turn (always expanded).
  if (activeTurnId && !turnIdsSeen.has(activeTurnId)) {
    const tools = collapseTurnTools(snapshot.activity, activeTurnId);
    if (tools.length > 0) {
      items.push({ kind: "tools", turnId: activeTurnId, tools, collapsed: false });
    }
  }

  return items;
}

function summarizeTools(tools: ToolEntry[]): string {
  const failed = tools.filter(
    (t) => t.status !== "ok" && t.status !== "accepted" && t.status !== "completed",
  ).length;
  const noun = tools.length === 1 ? "tool call" : "tool calls";
  return failed > 0 ? `${tools.length} ${noun} · ${failed} failed` : `${tools.length} ${noun}`;
}

export function ChatRoute(props: { snapshot: SessionViewSnapshot; verbosity: Verbosity }) {
  const flow = () => buildFlow(props.snapshot, props.verbosity);
  const pendingApprovals = () => props.snapshot.approvals.filter((a) => a.status === "pending");
  const runningTasks = () => props.snapshot.tasks.filter((t) => t.status === "running");

  return (
    <scrollbox
      flexGrow={1}
      stickyScroll
      stickyStart="bottom"
      paddingX={1}
      paddingY={1}
      backgroundColor={COLORS.base}
      scrollbarOptions={{ showArrows: false }}
    >
      <Show when={props.snapshot.transcript.length === 0}>
        <IntroPanel snapshot={props.snapshot} />
      </Show>
      <For each={flow()}>
        {(item) =>
          item.kind === "message" ? (
            <MessageRow message={item.message} />
          ) : item.collapsed ? (
            <text fg={COLORS.dim} content={`  · ${summarizeTools(item.tools)}`} />
          ) : (
            <box flexDirection="column" marginBottom={1}>
              <For each={item.tools}>
                {(entry) => (
                  <InlineToolLine entry={entry} alwaysPreview={props.verbosity === "verbose"} />
                )}
              </For>
            </box>
          )
        }
      </For>
      <For each={pendingApprovals()}>
        {(approval) => <InlineApprovalCard approval={approval} />}
      </For>
      <For each={runningTasks()}>{(task) => <InlineTaskCard task={task} />}</For>
    </scrollbox>
  );
}

function IntroPanel(props: { snapshot: SessionViewSnapshot }) {
  return (
    <box flexDirection="column" gap={1}>
      <text fg={COLORS.green} attributes={TextAttributes.BOLD} content="Sloppy TUI" />
      <text
        fg={COLORS.text}
        wrapMode="word"
        content="Attached to the public agent-session provider. State updates arrive as SLOP snapshots; actions go back through contextual affordances."
      />
      <text fg={COLORS.dim} content="Ctrl+K palette · ⇧⇥ mode · /help · /cmd" />
      <Show when={props.snapshot.llm.status === "needs_credentials"}>
        <text fg={COLORS.yellow} content="LLM credentials are missing. Open setup with /setup." />
      </Show>
    </box>
  );
}
