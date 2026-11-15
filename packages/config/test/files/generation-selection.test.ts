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

test("roster load rejects a maxTokens the generation transport would refuse at request time", () => {
  const agent = {
    name: "generator",
    adapter: "openai-compat-http",
    api_provider: "local",
    roles: ["memory-refiner"],
    options: { baseUrl: "http://127.0.0.1:7944/v1", maxTokens: GENERATION_MAX_TOKENS_CAP },
  };
  expect(GENERATION_MAX_TOKENS_CAP).toBe(16_384);
  expect(AgentsConfigSchema.safeParse({ agents: [agent] }).success).toBe(true);
  for (const maxTokens of [GENERATION_MAX_TOKENS_CAP + 1, 0, -1]) {
    const result = AgentsConfigSchema.safeParse({
      agents: [{ ...agent, options: { ...agent.options, maxTokens } }],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "maxTokens must be an integer from 1 to 16384",
    );
  }
});
