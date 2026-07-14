import type { LlmProtocol } from "../config/schema";
import type { ProviderContinuationIssuer } from "./types";

function canonicalHeaders(headers: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(headers ?? {})
    .map(([name, value]): [string, string] => [name.toLowerCase(), value])
    .sort(([left], [right]) => left.localeCompare(right));
}

export function createProviderContinuationScope(input: {
  protocol: LlmProtocol;
  provider: string;
  baseUrl: string;
  credentialIdentity?: string;
  headers?: Record<string, string>;
}): string {
  const payload = JSON.stringify({
    protocol: input.protocol,
    provider: input.provider,
    baseUrl: input.baseUrl,
    credentialIdentity: input.credentialIdentity ?? "",
    headers: canonicalHeaders(input.headers),
  });
  const digest = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
  return `sha256:${digest}`;
}

export function createProviderContinuationIssuer(input: {
  protocol: LlmProtocol;
  provider: string;
  model: string;
  baseUrl: string;
  credentialIdentity?: string;
  headers?: Record<string, string>;
}): ProviderContinuationIssuer {
  return {
    protocol: input.protocol,
    provider: input.provider,
    model: input.model,
    scope: createProviderContinuationScope(input),
  };
}
