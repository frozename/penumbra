import { describe, it, expect } from "bun:test";
import { isEnvelopeResult } from "../../src/responses/envelope.js";
import { chainListAgentsHandler } from "../../src/tools/chain-list-agents.js";

function fakeDaemon(listChainAgents?: () => Promise<unknown>): any {
  return {
    listChainAgents:
      listChainAgents ??
      (async () => ({
        agents: [{ name: "planner" }, { name: "executor" }],
      })),
  };
}

describe("chain_list_agents - envelope opt-in", () => {
  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const handler = chainListAgentsHandler(fakeDaemon());
    const result: any = await handler({ envelope: true } as any);

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.limit).toBe(8000);
    expect(result._meta.result_bytes).toBeGreaterThanOrEqual(0);
    expect(result.content[0].type).toBe("text");
  });

  it("returns the current raw JSON shape when envelope is omitted", async () => {
    const payload = { agents: [{ name: "planner" }, { name: "executor" }] };
    const handler = chainListAgentsHandler(fakeDaemon(async () => payload));
    const result: any = await handler({} as any);

    expect(isEnvelopeResult(result)).toBe(false);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe(JSON.stringify(payload, null, 2));
  });

  it("keeps the non-envelope payload byte-identical when envelope=false", async () => {
    const payload = { agents: [{ name: "planner" }, { name: "executor" }] };
    const handler = chainListAgentsHandler(fakeDaemon(async () => payload));
    const result: any = await handler({ envelope: false } as any);

    expect(isEnvelopeResult(result)).toBe(false);
    expect(result.content[0].text).toBe(JSON.stringify(payload, null, 2));
  });

  it("truncates envelope text for over-budget payloads and reports full result_bytes", async () => {
    const payload = {
      agents: Array.from({ length: 4000 }, (_, i) => ({
        name: "agent-" + i,
        notes: "x".repeat(50) + i,
      })),
    };
    const handler = chainListAgentsHandler(fakeDaemon(async () => payload));
    const result: any = await handler({ envelope: true } as any);

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.truncated).toBe(true);
    expect(result.content[0].text.length).toBe(8000 * 4);
    expect(result._meta.result_bytes).toBe(
      Buffer.byteLength(JSON.stringify(payload, null, 2), "utf8"),
    );
  });
});
