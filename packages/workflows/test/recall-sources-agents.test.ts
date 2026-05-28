import { expect, test } from "bun:test";

import { runAgentsSource } from "../src/recall-sources/agents.js";

test("agents source returns registry agents", () => {
  const stub = {
    listAgents() {
      return [{ name: "a" }, { name: "b" }];
    },
  };

  const out = runAgentsSource({ agentRegistry: stub });

  expect(out.agents).toEqual([{ name: "a" }, { name: "b" }]);
  expect(out.warnings).toEqual([]);
});

test("agents source warns when registry is missing", () => {
  const out = runAgentsSource({});

  expect(out.agents).toEqual([]);
  expect(out.warnings.some((w) => w.includes("registry not provided"))).toBe(true);
});
