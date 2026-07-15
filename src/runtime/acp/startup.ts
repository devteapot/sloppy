import type * as acp from "@agentclientprotocol/sdk";

export type AcpAuthMethodPreference = {
  id: string;
  whenEnv?: string;
};

export type AcpAuthenticationSelection = {
  advertisedMethodIds: string[];
  selectedMethodId?: string;
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function advertisedAuthMethodIds(response: acp.InitializeResponse): string[] {
  return (response.authMethods ?? []).map((method) => method.id);
}

function advertisedDefaultAuthMethodId(response: acp.InitializeResponse): string | undefined {
  const meta = response._meta;
  return meta && typeof meta === "object" ? nonEmptyString(meta.defaultAuthMethodId) : undefined;
}

function environmentHasValue(environment: NodeJS.ProcessEnv, name: string): boolean {
  return Boolean(environment[name]?.trim());
}

export function selectAcpAuthenticationMethod(options: {
  response: acp.InitializeResponse;
  preferences?: AcpAuthMethodPreference[];
  environment: NodeJS.ProcessEnv;
}): AcpAuthenticationSelection {
  const advertisedMethodIds = advertisedAuthMethodIds(options.response);
  const advertised = new Set(advertisedMethodIds);

  for (const preference of options.preferences ?? []) {
    if (preference.whenEnv && !environmentHasValue(options.environment, preference.whenEnv)) {
      continue;
    }
    if (advertised.has(preference.id)) {
      return { advertisedMethodIds, selectedMethodId: preference.id };
    }
  }

  const defaultMethodId = advertisedDefaultAuthMethodId(options.response);
  if (defaultMethodId && advertised.has(defaultMethodId)) {
    return { advertisedMethodIds, selectedMethodId: defaultMethodId };
  }

  if (advertisedMethodIds.length === 1) {
    return { advertisedMethodIds, selectedMethodId: advertisedMethodIds[0] };
  }

  return { advertisedMethodIds };
}

export function resolveAcpSessionModelSelection(options: {
  modelOverride?: string;
  modelState?: acp.SessionModelState | null;
}): {
  requestedModelId?: string;
  currentModelId?: string;
  availableModelIds?: string[];
} {
  const requestedModelId = nonEmptyString(options.modelOverride);
  const currentModelId = nonEmptyString(options.modelState?.currentModelId);

  if (!requestedModelId || requestedModelId === "default" || requestedModelId === currentModelId) {
    return { currentModelId };
  }

  if (!options.modelState) {
    return { currentModelId };
  }

  return {
    requestedModelId,
    currentModelId,
    availableModelIds: options.modelState.availableModels.map((model) => model.modelId),
  };
}
