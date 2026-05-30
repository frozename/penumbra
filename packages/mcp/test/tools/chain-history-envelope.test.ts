import { describe, it, expect } from "bun:test";
import { isEnvelopeResult } from "../../src/responses/envelope.js";
import { chainHistoryHandler } from "../../src/tools/chain-history.js";

function fakeDaemon(listChainHistory?: (conversationId: string, limit?: number) => Promise<unknown>): any {
  return {
    listChainHistory:
      listChainHistory ??
      (async () => ({
        history: [
          {
            ts: "2026-05-01T00:00:00Z",
            reason: "max_hops reached",
            hop_count: 5,
            terminal_handoff_id: "h1",
            conversation_id: "c1",
          },
        ],
      })),
  };
}

describe("chain_history - envelope opt-in", () => {
  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const handler = chainHistoryHandler(fakeDaemon());
    const result: any = await handler({ conversation_id: "c1", envelope: true });

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.limit).toBe(8000);
    expect(result._meta.result_bytes).toBeGreaterThanOrEqual(0);
    expect(result.content[0].type).toBe("text");
  });

  it("returns the current raw JSON shape when envelope is omitted", async () => {
    const history = [{ ts: "2026-05-01T00:00:00Z", reason: "completed", conversation_id: "c1" }];
    const handler = chainHistoryHandler(fakeDaemon(async () => ({ history })));
    const result: any = await handler({ conversation_id: "c1" });

    expect(isEnvelopeResult(result)).toBe(false);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe(JSON.stringify(history, null, 2));
  });

  it("keeps the non-envelope payload byte-identical when envelope=false", async () => {
    const history = [{ ts: "2026-05-01T00:00:00Z", reason: "completed", conversation_id: "c1" }];
    const handler = chainHistoryHandler(fakeDaemon(async () => ({ history })));
    const result: any = await handler({ conversation_id: "c1", envelope: false });

    expect(isEnvelopeResult(result)).toBe(false);
    expect(result.content[0].text).toBe(JSON.stringify(history, null, 2));
  });

  it("truncates envelope text for over-budget payloads and reports full result_bytes", async () => {
    const history = Array.from({ length: 4000 }, (_, i) => ({
      ts: "2026-05-01T00:00:00Z",
      reason: "x".repeat(50) + i,
      conversation_id: "c1",
    }));
    const handler = chainHistoryHandler(fakeDaemon(async () => ({ history })));
    const result: any = await handler({ conversation_id: "c1", envelope: true });

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.truncated).toBe(true);
    expect(result.content[0].text.length).toBe(8000 * 4);
    expect(result._meta.result_bytes).toBe(
      Buffer.byteLength(JSON.stringify(history, null, 2), "utf8"),
    );
  });
});
