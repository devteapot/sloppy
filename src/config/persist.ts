import { dirname } from "node:path";
import YAML from "yaml";

import { getHomeConfigPath, readConfigFile } from "./load";
import type { LlmConfig } from "./schema";

function toPersistedLlmConfig(config: LlmConfig): Record<string, unknown> {
  return {
    provider: config.provider,
    model: config.model,
    apiKeyEnv: config.apiKeyEnv,
    baseUrl: config.baseUrl,
    defaultProfileId: config.defaultProfileId,
    maxTokens: config.maxTokens,
    profiles: config.profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      provider: profile.provider,
      model: profile.model,
      apiKeyEnv: profile.apiKeyEnv,
      baseUrl: profile.baseUrl,
    })),
  };
}

export async function writeHomeLlmConfig(config: LlmConfig): Promise<void> {
  const homeConfigPath = getHomeConfigPath();
  const nextConfig = await readConfigFile(homeConfigPath);
  nextConfig.llm = toPersistedLlmConfig(config);

  await Bun.$`mkdir -p ${dirname(homeConfigPath)}`;
  await Bun.write(homeConfigPath, YAML.stringify(nextConfig));
}
