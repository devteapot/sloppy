import { describe, expect, test } from "bun:test";

import { createProviderContinuationIssuer } from "../src/llm/continuation";
import type { ProviderContinuationContentBlock } from "../src/llm/types";
import { isProviderContinuationFor } from "../src/llm/types";

function issuer(overrides: { baseUrl?: string; credentialIdentity?: string } = {}) {
  return createProviderContinuationIssuer({
    protocol: "openai-responses",
    provider: "corp-openai",
    model: "gpt-5.4",
    baseUrl: overrides.baseUrl ?? "https://one.example/v1",
    credentialIdentity: overrides.credentialIdentity ?? "account-one-key",
    headers: { "x-tenant": "alpha" },
  });
}

describe("provider continuation issuer scope", () => {
  test("matches only the same wire origin and credential identity", () => {
    const original = issuer();
    const block: ProviderContinuationContentBlock = {
      type: "provider_continuation",
      purpose: "reasoning",
      issuer: original,
      data: { encrypted_content: "opaque" },
    };

    expect(isProviderContinuationFor(block, issuer())).toBe(true);
    expect(isProviderContinuationFor(block, issuer({ baseUrl: "https://two.example/v1" }))).toBe(
      false,
    );
    expect(
      isProviderContinuationFor(block, issuer({ credentialIdentity: "account-two-key" })),
    ).toBe(false);
  });

  test("never stores raw credential material in the issuer tag", () => {
    const resolved = issuer();

    expect(resolved.scope).toStartWith("sha256:");
    expect(resolved.scope).not.toContain("account-one-key");
  });
});
