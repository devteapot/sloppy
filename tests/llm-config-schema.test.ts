import { describe, expect, test } from "bun:test";

import { sloppyConfigSchema } from "../src/config/schema";

describe("LLM config schema", () => {
  test("rejects sensitive literal endpoint headers", () => {
    expect(() =>
      sloppyConfigSchema.parse({
        llm: {
          endpoints: {
            routed: {
              protocol: "openai-chat",
              headers: { Authorization: "Bearer secret" },
            },
          },
        },
      }),
    ).toThrow("must use headerEnv");

    for (const header of ["x-client-secret", "x-auth-key", "credential"]) {
      expect(() =>
        sloppyConfigSchema.parse({
          llm: {
            endpoints: {
              routed: {
                protocol: "openai-chat",
                headers: { [header]: "must-not-be-persisted" },
              },
            },
          },
        }),
      ).toThrow("must use headerEnv");
    }
  });

  test("accepts env-backed headers and applies request-policy defaults", () => {
    const config = sloppyConfigSchema.parse({
      llm: {
        endpoints: {
          routed: {
            protocol: "openai-chat",
            headers: { "x-route": "blue" },
            headerEnv: { Authorization: "ROUTED_LLM_TOKEN" },
          },
        },
      },
    });

    expect(config.llm.endpoints.routed?.headerEnv).toEqual({
      Authorization: "ROUTED_LLM_TOKEN",
    });
    expect(config.llm.requestPolicy).toEqual({
      timeoutMs: 120_000,
      maxRetries: 2,
      baseRetryDelayMs: 500,
      maxRetryDelayMs: 10_000,
    });
  });

  test("rejects malformed base URLs and inverted retry bounds", () => {
    expect(() =>
      sloppyConfigSchema.parse({
        llm: {
          endpoints: {
            routed: {
              protocol: "openai-chat",
              baseUrl: "not-a-url",
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      sloppyConfigSchema.parse({
        llm: {
          requestPolicy: {
            baseRetryDelayMs: 1_000,
            maxRetryDelayMs: 100,
          },
        },
      }),
    ).toThrow("maxRetryDelayMs");
    expect(() =>
      sloppyConfigSchema.parse({
        llm: {
          requestPolicy: {
            timeoutMs: 2_147_483_648,
          },
        },
      }),
    ).toThrow();
  });

  test("restricts endpoint URLs to credential-safe HTTP transports", () => {
    for (const baseUrl of [
      "ftp://llm.example.test/v1",
      "data:text/plain,not-an-endpoint",
      "https://user:password@llm.example.test/v1",
      "https://llm.example.test/v1#fragment",
      "https://llm.example.test/v1?api_key=secret",
    ]) {
      expect(() =>
        sloppyConfigSchema.parse({
          llm: {
            endpoints: {
              routed: {
                protocol: "openai-chat",
                baseUrl,
                auth: { type: "none" },
              },
            },
          },
        }),
      ).toThrow();
    }

    for (const endpoint of [
      {
        protocol: "openai-chat" as const,
        baseUrl: "http://llm.example.test/v1",
        auth: { type: "env" as const, env: "ROUTED_LLM_TOKEN" },
      },
      {
        protocol: "openai-chat" as const,
        baseUrl: "http://llm.example.test/v1",
        auth: { type: "none" as const },
        headerEnv: { Authorization: "ROUTED_LLM_TOKEN" },
      },
    ]) {
      expect(() =>
        sloppyConfigSchema.parse({
          llm: { endpoints: { routed: endpoint } },
        }),
      ).toThrow("must use https");
    }

    const config = sloppyConfigSchema.parse({
      llm: {
        endpoints: {
          local: {
            protocol: "openai-chat",
            baseUrl: "http://localhost:11434/v1",
            auth: { type: "none" },
          },
          authenticated: {
            protocol: "openai-chat",
            baseUrl: "https://llm.example.test/v1",
            auth: { type: "env", env: "ROUTED_LLM_TOKEN" },
          },
        },
      },
    });

    expect(config.llm.endpoints.local?.baseUrl).toBe("http://localhost:11434/v1");
    expect(config.llm.endpoints.authenticated?.baseUrl).toBe("https://llm.example.test/v1");
  });

  test("rejects generic key-like literal headers", () => {
    expect(() =>
      sloppyConfigSchema.parse({
        llm: {
          endpoints: {
            routed: {
              protocol: "openai-chat",
              headers: { "ocp-apim-subscription-key": "secret" },
            },
          },
        },
      }),
    ).toThrow("must use headerEnv");
  });
});
