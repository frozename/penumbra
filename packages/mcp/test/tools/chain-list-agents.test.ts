import { expect, test, mock } from "bun:test";
import { z } from "zod";
import {
  chainListAgentsHandler,
  ChainListAgentsInputShape,
} from "../../src/tools/chain-list-agents.js";

test("ChainListAgentsInputShape accepts optional envelope", () => {
  const schema = z.object(ChainListAgentsInputShape);
  expect(schema.parse({})).toEqual({});
  expect(schema.parse({ envelope: true }).envelope).toBe(true);
});

test("chainListAgentsHandler calls daemon.listChainAgents and formats output", async () => {
  const daemon = {
    listChainAgents: mock().mockResolvedValue({
      agents: [{ name: "planner" }, { name: "executor" }],
    }),
  } as any;

  const handler = chainListAgentsHandler(daemon);
  const res = await handler({});

  expect(daemon.listChainAgents).toHaveBeenCalledTimes(1);
  expect(res.content[0].type).toBe("text");
  expect(JSON.parse(res.content[0].text)).toEqual({
    agents: [{ name: "planner" }, { name: "executor" }],
  });
});
