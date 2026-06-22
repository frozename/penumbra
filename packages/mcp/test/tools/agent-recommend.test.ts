import { describe, expect, it } from "bun:test";

import type { DaemonClient } from "../../src/daemon-client.js";

import {
  agentRecommendHandler,
  AgentRecommendInputSchema,
} from "../../src/tools/agent-recommend.js";
import { fakeDaemon } from "../helpers.js";

type AgentRecommendFn = DaemonClient["agentRecommend"];
type AgentRecommendReq = Parameters<AgentRecommendFn>[0];

describe("agent.recommend input schema", () => {
  it("requires valid task_type", () => {
    expect(
      AgentRecommendInputSchema.safeParse({ task_type: "implement_substantial" }).success,
    ).toBe(true);
    expect(AgentRecommendInputSchema.safeParse({ task_type: "" }).success).toBe(false);
  });
});

describe("agent.recommend handler", () => {
  it("forwards task_type only and returns JSON text", async () => {
    const calls: AgentRecommendReq[] = [];
    const agentRecommend: AgentRecommendFn = (input) => {
      calls.push(input);
      return Promise.resolve([{ agent_name: "alpha", task_type: "implement_substantial" }]);
    };
    const handler = agentRecommendHandler(fakeDaemon({ agentRecommend }));

    const out = await handler({ task_type: "implement_substantial" });
    expect(calls).toEqual([
      { task_type: "implement_substantial", risk_class: undefined, window_days: undefined },
    ]);
    const block = out.content[0];
    if (block === undefined) throw new Error("expected content[0]");
    expect(JSON.parse(block.text)).toEqual([
      { agent_name: "alpha", task_type: "implement_substantial" },
    ]);
  });

  it("forwards optional filters", async () => {
    const calls: AgentRecommendReq[] = [];
    const agentRecommend: AgentRecommendFn = (input) => {
      calls.push(input);
      return Promise.resolve([{ agent_name: "beta", task_type: "implement_substantial" }]);
    };
    const handler = agentRecommendHandler(fakeDaemon({ agentRecommend }));

    await handler({ task_type: "implement_substantial", risk_class: "high", window_days: 14 });
    expect(calls).toEqual([
      { task_type: "implement_substantial", risk_class: "high", window_days: 14 },
    ]);
  });

  it("accepts agent_kind in the schema", () => {
    expect(
      AgentRecommendInputSchema.safeParse({
        task_type: "implement_substantial",
        agent_kind: "long_lived",
      }).success,
    ).toBe(true);
  });
});
