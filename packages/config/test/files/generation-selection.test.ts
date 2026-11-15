import { expect, test } from "bun:test";

import { AgentsConfigSchema, GENERATION_MAX_TOKENS_CAP } from "@src/files/agents.js";

test("HTTP generation pools accept explicit ordered failover and reject unknown selection modes", () => {
  const agent = {
    name: "generator",
    adapter: "openai-compat-http",
    api_provider: "local",
    roles: ["memory-refiner"],
    options: { baseUrl: "http://127.0.0.1:7944/v1", candidateSelection: "ordered" },
  };
  expect(AgentsConfigSchema.safeParse({ agents: [agent] }).success).toBe(true);
  expect(
    AgentsConfigSchema.safeParse({
      agents: [{ ...agent, options: { ...agent.options, candidateSelection: "random" } }],
    }).success,
  ).toBe(false);
});

test("roster load accepts any integer maxTokens; the generation cap is enforced per role", () => {
  // maxTokens is a general openai-compat-http option. A dispatch-only seat may carry a value
  // above the generation transport cap, and the whole agents.yaml must still load. The cap is
  // checked when a seat is resolved for a daemon generation role (core resolveRoleLlmCandidates).
  const dispatchOnly = {
    name: "dispatch-seat",
    adapter: "openai-compat-http",
    api_provider: "local",
    roles: ["executor"],
    options: { baseUrl: "http://127.0.0.1:7944/v1", maxTokens: 32_768 },
  };
  expect(GENERATION_MAX_TOKENS_CAP).toBe(16_384);
  expect(AgentsConfigSchema.safeParse({ agents: [dispatchOnly] }).success).toBe(true);
  expect(
    AgentsConfigSchema.safeParse({
      agents: [{ ...dispatchOnly, roles: ["executor", "memory-refiner"] }],
    }).success,
  ).toBe(true);
  expect(
    AgentsConfigSchema.safeParse({
      agents: [{ ...dispatchOnly, options: { ...dispatchOnly.options, maxTokens: 1.5 } }],
    }).success,
  ).toBe(false);
});
