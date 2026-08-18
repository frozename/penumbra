import { expect, test } from "bun:test";

import * as llmCandidates from "../../src/services/llm-candidates.js";

const resolver = (input: unknown): unknown =>
  (llmCandidates as Record<string, (value: unknown) => unknown>).resolveRoleLlmCandidates(input);

test("resolves role-tagged local seats before subscription HTTP seats before process adapters", () => {
  const candidates = resolver({
    roleTag: "dreaming-rewriter",
    agentchatConfig: {
      agents: [
        {
          name: "cli-first-in-config",
          adapter: "codex-cli",
          roles: ["dreaming-rewriter"],
          pricing_mode: "subscription",
          subscription_provider: "openai",
          options: { model: "codex" },
        },
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
          pricing_mode: "subscription",
          subscription_provider: "anthropic",
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
    "cli-first-in-config",
    "acp-third-in-config",
  ]);
  expect(candidates.map(({ provider }) => provider)).toEqual([
    "local",
    "local",
    "sakana",
    "openai",
    "anthropic",
  ]);
  expect(candidates.map(({ adapter }) => adapter)).toEqual([
    "openai-compat-http",
    "openai-compat-http",
    "openai-compat-http",
    "codex-cli",
    "stdio-acp",
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
