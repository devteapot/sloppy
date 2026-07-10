import type { SloppyConfig } from "../config/schema";
import type { InvokePolicy } from "../core/policy";
import type { LlmProfileManager } from "../llm/profile-manager";
import type { AgentSessionProvider } from "../session/provider";
import type {
  ExternalSessionAgentState,
  SessionAgentFactory,
  SessionRuntime,
} from "../session/runtime";

export type ChildSessionFactoryOptions = {
  config: SloppyConfig;
  sessionId: string;
  title: string;
  providerId: string;
  providerName: string;
  agentFactory?: SessionAgentFactory;
  ignoredProviderIds?: string[];
  llmProfileManager?: LlmProfileManager;
  llmProfileId?: string;
  llmModelOverride?: string;
  requiresLlmProfile?: boolean;
  externalAgentState?: ExternalSessionAgentState;
  policyRules?: InvokePolicy[];
  parentActorId?: string;
};

export type ChildSessionHandle = {
  runtime: SessionRuntime;
  provider: AgentSessionProvider;
};

export type ChildSessionFactory = (options: ChildSessionFactoryOptions) => ChildSessionHandle;
