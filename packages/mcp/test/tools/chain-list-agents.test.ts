import { expect, mock, test } from "bun:test";
import { z } from "zod";

import type { DaemonClient } from "@src/daemon-client.js";
import { chainListAgentsHandler, ChainListAgentsInputShape } from "@src/tools/chain-list-agents.js";

import { fakeDaemon } from "../helpers.js";

type ListChainAgentsFn = DaemonClient["listChainAgents"];

test("ChainListAgentsInputShape exposes no retired envelope flag", () => {
  const schema = z.object(ChainListAgentsInputShape);
  expect(schema.parse({})).toEqual({});
  expect("envelope" in ChainListAgentsInputShape).toBe(false);
});

test("chainListAgentsHandler calls daemon.listChainAgents and formats output", async () => {
  const listChainAgents = mock<ListChainAgentsFn>(() =>
    Promise.resolve({ agents: [{ name: "planner" }, { name: "executor" }] }),
  );
  const daemon = fakeDaemon({ listChainAgents });

  const handler = chainListAgentsHandler(daemon);
  const res = await handler({});

  expect(listChainAgents).toHaveBeenCalledTimes(1);
  expect(res.content[0].type).toBe("text");
  const text = res.content[0].text;
  if (typeof text !== "string") throw new Error("expected text content");
  expect(JSON.parse(text)).toEqual({
    agents: [{ name: "planner" }, { name: "executor" }],
  });
});

test("chainListAgentsHandler passes each seat's health through unchanged (#256)", async () => {
  type ChainAgentsList = Awaited<ReturnType<ListChainAgentsFn>>;
  const listed: ChainAgentsList = {
    agents: [
      {
        name: "a",
        health: {
          state: "unauthorized",
          checked_at: "1970-01-01T00:00:02.000Z",
          http_status: 401,
        },
      },
      { name: "b" },
    ],
  };
  const listChainAgents = mock<ListChainAgentsFn>(() => Promise.resolve(listed));
  const res = await chainListAgentsHandler(fakeDaemon({ listChainAgents }))({});
  const text = res.content[0]?.text;
  if (typeof text !== "string") throw new Error("expected text content");
  expect(JSON.parse(text)).toEqual(listed);
});
