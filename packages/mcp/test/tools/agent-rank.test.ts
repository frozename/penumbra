import { describe, expect, it } from "bun:test";
import { AgentRankInputSchema, agentRankHandler } from "../../src/tools/agent-rank.js";

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
    const calls: unknown[] = [];
    const handler = agentRankHandler({
      agentRank: async (input: unknown) => {
        calls.push(input);
        return {
          task_type: "implement_substantial",
          window: { from: "a", to: "b" },
          candidates: [],
        };
      },
    } as any);

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
    expect(JSON.parse(out.content[0]!.text)).toEqual({
      task_type: "implement_substantial",
      window: { from: "a", to: "b" },
      candidates: [],
    });
  });

  it("forwards agent_kind when provided", async () => {
    const calls: unknown[] = [];
    const handler = agentRankHandler({
      agentRank: async (input: unknown) => {
        calls.push(input);
        return {
          task_type: "implement_substantial",
          window: { from: "a", to: "b" },
          candidates: [],
        };
      },
    } as any);

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
