import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

import { DEFAULT_LLM_ENDPOINTS } from "../llm/catalog";
import { getHomeConfigPath, readConfigFile } from "./load";
import type { LlmConfig, LlmEndpointConfig, LlmEndpointModelConfig } from "./schema";

function definedFields<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function toPersistedEndpointModel(model: LlmEndpointModelConfig): LlmEndpointModelConfig {
  return definedFields({
    label: model.label,
    contextWindowTokens: model.contextWindowTokens,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: model.capabilities,
    compat: model.compat,
  }) as LlmEndpointModelConfig;
}

function toPersistedEndpoint(endpoint: LlmEndpointConfig): LlmEndpointConfig {
  return {
    ...(definedFields({
      label: endpoint.label,
      baseUrl: endpoint.baseUrl,
      headers: endpoint.headers,
    }) as Partial<LlmEndpointConfig>),
    protocol: endpoint.protocol,
    auth: endpoint.auth,
    models: Object.fromEntries(
      Object.entries(endpoint.models).map(([modelId, model]) => [
        modelId,
        toPersistedEndpointModel(model),
      ]),
    ),
  };
}

function isUnchangedBuiltInEndpoint(endpointId: string, endpoint: LlmEndpointConfig): boolean {
  const builtInEndpoint = DEFAULT_LLM_ENDPOINTS[endpointId];
  if (!builtInEndpoint) {
    return false;
  }

  return isDeepStrictEqual(toPersistedEndpoint(endpoint), toPersistedEndpoint(builtInEndpoint));
}

function toPersistedEndpoints(config: LlmConfig): Record<string, LlmEndpointConfig> {
  return Object.fromEntries(
    Object.entries(config.endpoints).flatMap(([endpointId, endpoint]) =>
      isUnchangedBuiltInEndpoint(endpointId, endpoint)
        ? []
        : [[endpointId, toPersistedEndpoint(endpoint)]],
    ),
  );
}

function toPersistedLlmConfig(config: LlmConfig): Record<string, unknown> {
  return {
    reasoningEffort: config.reasoningEffort,
    thinking: config.thinking,
    endpoints: toPersistedEndpoints(config),
    defaultProfileId: config.defaultProfileId,
    maxTokens: config.maxTokens,
    profiles: config.profiles.map((profile) => ({ ...profile })),
  };
}

export async function writeHomeLlmConfig(config: LlmConfig): Promise<void> {
  const homeConfigPath = getHomeConfigPath();
  const nextConfig = await readConfigFile(homeConfigPath);
  nextConfig.llm = toPersistedLlmConfig(config);

  await Bun.$`mkdir -p ${dirname(homeConfigPath)}`;
  await Bun.write(homeConfigPath, YAML.stringify(nextConfig));
}
