import { loadConfig } from "../config/load";
import type { SloppyConfig } from "../config/schema";
import { createLlmAdapter } from "../llm/factory";
import type { LlmAdapter } from "../llm/types";
import { createRegisteredProviders } from "../providers/registry";
import { ConsumerHub } from "./consumer";
import { ConversationHistory } from "./history";
import { runLoop } from "./loop";

export interface AgentCallbacks {
  onText?: (chunk: string) => void;
  onToolCall?: (summary: string) => void;
  onToolResult?: (summary: string) => void;
}

export class Agent {
  private config: SloppyConfig;
  private hub: ConsumerHub | null = null;
  private history: ConversationHistory;
  private llm: LlmAdapter;
  private callbacks: AgentCallbacks;

  constructor(options?: { config?: SloppyConfig } & AgentCallbacks) {
    this.config = options?.config ?? loadConfig();
    this.callbacks = {
      onText: options?.onText,
      onToolCall: options?.onToolCall,
      onToolResult: options?.onToolResult,
    };
    this.history = new ConversationHistory({
      historyTurns: this.config.agent.historyTurns,
      toolResultMaxChars: this.config.agent.toolResultMaxChars,
    });
    this.llm = createLlmAdapter(this.config);
  }

  async start(): Promise<void> {
    if (this.hub) {
      return;
    }

    const providers = createRegisteredProviders(this.config);
    const hub = new ConsumerHub(providers, this.config);
    await hub.connect();
    this.hub = hub;
  }

  async chat(userMessage: string): Promise<string> {
    if (!this.hub) {
      throw new Error("Agent has not been started.");
    }

    this.history.addUserText(userMessage);
    return runLoop({
      config: this.config,
      hub: this.hub,
      history: this.history,
      llm: this.llm,
      onText: this.callbacks.onText,
      onToolCall: this.callbacks.onToolCall,
      onToolResult: this.callbacks.onToolResult,
    });
  }

  shutdown(): void {
    this.hub?.shutdown();
    this.hub = null;
  }
}
