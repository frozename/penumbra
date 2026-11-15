import { expect, test } from "bun:test";

import { AgentsConfigSchema } from "@src/files/agents.js";

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
