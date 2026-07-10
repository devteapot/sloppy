import { getDefaultEndpointModel } from "../llm/catalog";
import { asJsonObject, asString, deepMerge, type JsonObject } from "./json";

export function applyEnvironmentOverrides(config: JsonObject): JsonObject {
  const overrides: JsonObject = {};
  const endpointId = Bun.env.SLOPPY_LLM_ENDPOINT?.trim();
  const model = Bun.env.SLOPPY_MODEL?.trim();
  const profileId = Bun.env.SLOPPY_LLM_PROFILE?.trim();

  if (profileId) {
    overrides.llm = { defaultProfileId: profileId };
  }
  if (endpointId || model) {
    const runtimeProfileId = profileId ?? "runtime";
    const activeProfile = selectRawNativeProfile(config, profileId);
    const runtimeEndpointId = endpointId ?? asString(activeProfile?.endpointId) ?? "anthropic";
    overrides.llm = {
      ...(overrides.llm as JsonObject | undefined),
      defaultProfileId: runtimeProfileId,
      profiles: [
        {
          kind: "native",
          id: runtimeProfileId,
          label: "Runtime Override",
          endpointId: runtimeEndpointId,
          model:
            model ??
            getDefaultEndpointModel(runtimeEndpointId) ??
            firstRawEndpointModel(config, runtimeEndpointId) ??
            "default",
        },
      ],
    };
  }
  if (Bun.env.SLOPPY_LLM_REASONING_EFFORT) {
    overrides.llm = {
      ...(overrides.llm as JsonObject | undefined),
      reasoningEffort: Bun.env.SLOPPY_LLM_REASONING_EFFORT,
    };
  }
  if (Bun.env.SLOPPY_MAX_ITERATIONS) {
    overrides.agent = {
      maxIterations: Number.parseInt(Bun.env.SLOPPY_MAX_ITERATIONS, 10),
    };
  }
  return deepMerge(config, overrides);
}

function selectRawNativeProfile(
  config: JsonObject,
  preferredProfileId?: string,
): JsonObject | undefined {
  const llm = asJsonObject(config.llm);
  const rawProfiles = Array.isArray(llm?.profiles) ? llm.profiles : [];
  const profiles = rawProfiles.flatMap((profile) => {
    const candidate = asJsonObject(profile);
    const kind = asString(candidate?.kind);
    return candidate && (kind === undefined || kind === "native") ? [candidate] : [];
  });
  const preferred = preferredProfileId
    ? profiles.find((profile) => asString(profile.id) === preferredProfileId)
    : undefined;
  if (preferred) return preferred;
  const defaultProfileId = asString(llm?.defaultProfileId);
  return (
    (defaultProfileId
      ? profiles.find((profile) => asString(profile.id) === defaultProfileId)
      : undefined) ?? profiles[0]
  );
}

function firstRawEndpointModel(config: JsonObject, endpointId: string): string | undefined {
  const endpoints = asJsonObject(asJsonObject(config.llm)?.endpoints);
  const models = asJsonObject(asJsonObject(endpoints?.[endpointId])?.models);
  return models ? Object.keys(models)[0] : undefined;
}
