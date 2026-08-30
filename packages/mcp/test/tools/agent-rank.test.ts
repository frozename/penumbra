import type { DaemonClient } from "@src/daemon-client.js";

import { agentRankHandler, AgentRankInputSchema } from "@src/tools/agent-rank.js";
import { describe, expect, it } from "bun:test";

import { fakeDaemon } from "../helpers.js";

type AgentRankFn = DaemonClient["agentRank"];
type AgentRankReq = Parameters<AgentRankFn>[0];

describe("agent.rank input schema", () => {
  it("requires valid task_type", () => {
    expect(AgentRankInputSchema.safeParse({ task_type: "implement_substantial" }).success).toBe(
      true,
    );
    expect(AgentRankInputSchema.safeParse({ task_type: "bogus" }).success).toBe(false);
  });
});

describe("agent.rank handler", () => {
  it("forwards input and returns JSON text", async () => {
    const calls: AgentRankReq[] = [];
    const agentRank: AgentRankFn = (input) => {
      calls.push(input);
      return Promise.resolve({
        task_type: "implement_substantial",
        window: { from: "a", to: "b" },
        candidates: [],
      });
    };
    const handler = agentRankHandler(fakeDaemon({ agentRank }));

    const out = await handler({
      task_type: "implement_substantial",
      min_samples: 2,
      include_neutral: true,
      include_cost: true,
    });
    expect(calls).toEqual([
      {
        task_type: "implement_substantial",
        since: undefined,
        min_samples: 2,
        agent_kind: undefined,
        include_neutral: true,
        include_cost: true,
      },
    ]);
    const block = out.content[0];
    if (block === undefined) throw new Error("expected content[0]");
    expect(JSON.parse(block.text)).toEqual({
      task_type: "implement_substantial",
      window: { from: "a", to: "b" },
      candidates: [],
    });
  });

  it("forwards agent_kind when provided", async () => {
    const calls: AgentRankReq[] = [];
    const agentRank: AgentRankFn = (input) => {
      calls.push(input);
      return Promise.resolve({
        task_type: "implement_substantial",
        window: { from: "a", to: "b" },
        candidates: [],
      });
    };
    const handler = agentRankHandler(fakeDaemon({ agentRank }));

    await handler({ task_type: "implement_substantial", agent_kind: "long_lived" });
    expect(calls).toEqual([
      {
        task_type: "implement_substantial",
        since: undefined,
        min_samples: 1,
        agent_kind: "long_lived",
        include_neutral: false,
        include_cost: false,
      },
    ]);
  });
});
