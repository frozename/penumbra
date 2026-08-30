import { expect, mock, spyOn, test } from "bun:test";

import * as llmCandidates from "../../src/services/llm-candidates.js";

const resolver = (input: unknown): unknown =>
  (llmCandidates as Record<string, (value: unknown) => unknown>).resolveRoleLlmCandidates(input);

test("resolves allowed role-tagged HTTP seats before process adapters", () => {
  const candidates = resolver({
    roleTag: "dreaming-rewriter",
    agentchatConfig: {
      agents: [
        {
          name: "sakana-second-in-config",
          adapter: "openai-compat-http",
          roles: ["dreaming-rewriter"],
          pricing_mode: "subscription",
          subscription_provider: "sakana",
          options: {
            baseUrl: "https://api.sakana.ai/v1",
            model: "sakana-rewriter",
            provider: "sakana",
          },
        },
        {
          name: "acp-third-in-config",
          adapter: "stdio-acp",
          roles: ["dreaming-rewriter"],
          api_provider: "local",
          options: { binary: "claude", args: ["mcp"] },
        },
        {
          name: "local-fourth-in-config",
          adapter: "openai-compat-http",
          roles: ["dreaming-rewriter"],
          options: { baseUrl: "http://127.0.0.1:7944/v1", model: "local" },
        },
        {
          name: "local-third-in-config",
          adapter: "openai-compat-http",
          roles: ["dreaming-rewriter"],
          options: { baseUrl: "http://localhost:8080/v1", model: "other-local" },
        },
      ],
    },
  }) as { name: string; provider: string; adapter: string }[];

  expect(candidates.map(({ name }) => name)).toEqual([
    "local-fourth-in-config",
    "local-third-in-config",
    "sakana-second-in-config",
    "acp-third-in-config",
  ]);
  expect(candidates.map(({ provider }) => provider)).toEqual(["local", "local", "sakana", "local"]);
  expect(candidates.map(({ adapter }) => adapter)).toEqual([
    "openai-compat-http",
    "openai-compat-http",
    "openai-compat-http",
    "stdio-acp",
  ]);
});

test("maps keychain auth for role-tagged HTTP seats", () => {
  const candidates = resolver({
    roleTag: "dreaming-rewriter",
    agentchatConfig: {
      agents: [
        {
          name: "sakana-keychain",
          adapter: "openai-compat-http",
          roles: ["dreaming-rewriter"],
          options: {
            baseUrl: "https://api.sakana.ai/v1",
            model: "sakana-rewriter",
            provider: "sakana",
            apiKeyKeychain: "llamactl/sakana",
          },
        },
      ],
    },
  }) as { auth: unknown }[];

  expect(candidates[0]?.auth).toEqual({
    source: "keychain",
    service: "llamactl",
    account: "sakana",
  });
});

test("resolves env auth at authorization time", () => {
  const previous = process.env.PENUMBRA_TEST_LLM_KEY;
  delete process.env.PENUMBRA_TEST_LLM_KEY;
  const candidates = resolver({
    roleTag: "dreaming-rewriter",
    agentchatConfig: {
      agents: [
        {
          name: "sakana-env",
          adapter: "openai-compat-http",
          roles: ["dreaming-rewriter"],
          options: {
            baseUrl: "https://api.sakana.ai/v1",
            model: "sakana-rewriter",
            provider: "sakana",
            apiKeyEnv: "PENUMBRA_TEST_LLM_KEY",
          },
        },
      ],
    },
  }) as llmCandidates.LlmCandidate[];

  try {
    process.env.PENUMBRA_TEST_LLM_KEY = "late-bound-token";
    expect(llmCandidates.resolveLlmAuthorization(candidates[0]!)).toBe("late-bound-token");
  } finally {
    if (previous === undefined) delete process.env.PENUMBRA_TEST_LLM_KEY;
    else process.env.PENUMBRA_TEST_LLM_KEY = previous;
  }
});

test("resolves snake_case env auth at authorization time", () => {
  const previous = process.env.PENUMBRA_TEST_LLM_SNAKE_KEY;
  delete process.env.PENUMBRA_TEST_LLM_SNAKE_KEY;
  const candidates = resolver({
    roleTag: "dreaming-rewriter",
    agentchatConfig: {
      agents: [
        {
          name: "sakana-env",
          adapter: "openai-compat-http",
          roles: ["dreaming-rewriter"],
          options: {
            baseUrl: "https://api.sakana.ai/v1",
            model: "sakana-rewriter",
            provider: "sakana",
            api_key_env: "PENUMBRA_TEST_LLM_SNAKE_KEY",
          },
        },
      ],
    },
  }) as llmCandidates.LlmCandidate[];

  try {
    process.env.PENUMBRA_TEST_LLM_SNAKE_KEY = "late-bound-snake-token";
    expect(llmCandidates.resolveLlmAuthorization(candidates[0]!)).toBe("late-bound-snake-token");
  } finally {
    if (previous === undefined) delete process.env.PENUMBRA_TEST_LLM_SNAKE_KEY;
    else process.env.PENUMBRA_TEST_LLM_SNAKE_KEY = previous;
  }
});

test("maps file auth for role-tagged HTTP seats", () => {
  const candidates = resolver({
    roleTag: "dreaming-rewriter",
    agentchatConfig: {
      agents: [
        {
          name: "sakana-file",
          adapter: "openai-compat-http",
          roles: ["dreaming-rewriter"],
          options: {
            baseUrl: "https://api.sakana.ai/v1",
            model: "sakana-rewriter",
            provider: "sakana",
            apiKeyFile: "/tmp/penumbra-test-sakana-key",
          },
        },
      ],
    },
  }) as { auth: unknown }[];

  expect(candidates[0]?.auth).toEqual({
    source: "file",
    path: "/tmp/penumbra-test-sakana-key",
  });
});

test("drops external HTTP candidates that have no auth source", () => {
  const warn = spyOn(console, "warn").mockImplementation(mock(() => undefined));
  try {
    const candidates = llmCandidates.resolveLlmCandidates({
      purpose: "generation",
      candidates: [
        {
          name: "sakana-missing-auth",
          baseUrl: "https://api.sakana.ai/v1",
          model: "sakana-rewriter",
          provider: "sakana",
          auth: { source: "none" },
          adapter: "openai-compat-http",
        },
        {
          name: "local",
          baseUrl: "http://127.0.0.1:7944/v1",
          model: "local",
          provider: "local",
          auth: { source: "none" },
          adapter: "openai-compat-http",
        },
      ],
    });

    expect(candidates.map(({ name, tier }) => ({ name, tier }))).toEqual([
      { name: "local", tier: "primary" },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("sakana-missing-auth"),
      expect.stringContaining("missing_auth_for_external_http"),
    );
  } finally {
    warn.mockRestore();
  }
});

test("drops non-loopback HTTP candidates without auth even when provider is local", () => {
  const warn = spyOn(console, "warn").mockImplementation(mock(() => undefined));
  try {
    expect(() =>
      llmCandidates.resolveLlmCandidates({
        purpose: "generation",
        candidates: [
          {
            name: "external-mislabeled-local",
            baseUrl: "https://example.invalid/v1",
            model: "external",
            provider: "local",
            auth: { source: "none" },
            adapter: "openai-compat-http",
          },
        ],
      }),
    ).toThrow(/no eligible LLM candidate/i);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("external-mislabeled-local"),
      expect.stringContaining("missing_auth_for_external_http"),
    );
  } finally {
    warn.mockRestore();
  }
});

test("rejects disallowed adapter-backed providers before invocation", () => {
  expect(() =>
    llmCandidates.resolveLlmCandidates({
      purpose: "generation",
      candidates: [
        {
          name: "claude-acp",
          baseUrl: "adapter://claude-acp",
          model: "claude",
          provider: "anthropic",
          auth: { source: "none" },
          adapter: "stdio-acp",
        },
      ],
    }),
  ).toThrow(/provider.*anthropic.*not allowed/i);
});

test("rejects unknown providers before invocation", () => {
  expect(() =>
    llmCandidates.resolveLlmCandidates({
      purpose: "generation",
      candidates: [
        {
          name: "unknown-acp",
          baseUrl: "adapter://unknown-acp",
          model: "unknown",
          provider: "unknown",
          auth: { source: "none" },
          adapter: "stdio-acp",
        },
      ],
    }),
  ).toThrow(/provider.*unknown.*not allowed/i);
});

test("assigns primary tier after routing exclusions", () => {
  const candidates = llmCandidates.resolveLlmCandidates({
    purpose: "generation",
    candidates: [
      {
        name: "local-excluded",
        baseUrl: "http://127.0.0.1:7944/v1",
        model: "local",
        provider: "local",
        auth: { source: "none" },
        adapter: "openai-compat-http",
      },
      {
        name: "sakana-survivor",
        baseUrl: "https://api.sakana.ai/v1",
        model: "sakana-rewriter",
        provider: "sakana",
        auth: { source: "bearer", token: "token" },
        adapter: "openai-compat-http",
      },
    ],
    activeBiases: [
      {
        scope: "agent",
        value: "local-excluded",
        mode: "exclude",
        expires_at: "2026-09-01T00:00:00.000Z",
      },
    ],
    now: new Date("2026-08-18T12:00:00.000Z"),
  });

  expect(candidates.map(({ name, tier }) => ({ name, tier }))).toEqual([
    { name: "sakana-survivor", tier: "primary" },
  ]);
});

test("keeps role resolution non-throwing for partial or unrecognized HTTP config", () => {
  const candidates = resolver({
    roleTag: "memory-refiner",
    agentchatConfig: {
      agents: [
        {
          name: "synthetic-test-judge",
          adapter: "openai-compat-http",
          roles: ["memory-refiner"],
          options: { baseUrl: "http://agentchat-judge/v1", model: "granite" },
        },
      ],
    },
  }) as { name: string; provider: string }[];

  expect(candidates).toMatchObject([
    {
      name: "synthetic-test-judge",
      provider: "unknown",
    },
  ]);
});

test("uses the supplied legacy candidate when no seat carries the role", () => {
  const fallback = {
    name: "PENUMBRA_DREAMING_REWRITER_MODEL",
    baseUrl: "http://127.0.0.1:7944",
    model: "legacy-local",
    provider: "local",
    auth: { source: "none" },
  };
  expect(
    resolver({
      roleTag: "dreaming-rewriter",
      agentchatConfig: { agents: [] },
      fallbackCandidates: [fallback],
    }),
  ).toEqual([fallback]);
});
