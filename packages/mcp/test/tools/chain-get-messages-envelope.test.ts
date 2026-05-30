import { describe, it, expect } from "bun:test";
import { chainGetMessagesHandler } from "../../src/tools/chain-get-messages.js";
import { isEnvelopeResult } from "../../src/responses/envelope.js";

function fakeDaemon(
  getChainMessages?: (conversationId: string, types?: string[]) => Promise<unknown>,
): any {
  return {
    getChainMessages:
      getChainMessages ??
      (async () => ({
        items: [],
      })),
  };
}

describe("chain_get_messages - envelope opt-in", () => {
  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const res = { items: [{ id: "m1", role: "assistant", text: "hello" }] };
    const handler = chainGetMessagesHandler(fakeDaemon(async () => res));
    const result: any = await handler({ conversation_id: "conv-1", envelope: true });

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget).toBeDefined();
    expect(result._meta.token_budget.limit).toBe(8000);
    expect(result._meta.result_bytes).toBeGreaterThanOrEqual(0);
    expect(result.content[0].type).toBe("text");
  });

  it("returns the existing bare content envelope when envelope is omitted", async () => {
    const res = { items: [{ id: "m1", role: "assistant", text: "keep default path" }] };
    const handler = chainGetMessagesHandler(fakeDaemon(async () => res));
    const result: any = await handler({ conversation_id: "conv-1" });

    expect(isEnvelopeResult(result)).toBe(false);
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
    });
  });

  it("keeps the existing isError response even when envelope=true", async () => {
    const handler = chainGetMessagesHandler(
      fakeDaemon(async () => {
        throw new Error("boom");
      }),
    );

    const result: any = await handler({ conversation_id: "conv-1", envelope: true });
    expect(isEnvelopeResult(result)).toBe(false);
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Failed to fetch chain messages: boom" }],
    });
  });

  it("truncates envelope text and marks truncation when the success payload exceeds budget", async () => {
    const res = {
      items: [{ payload: "x".repeat(50_000) }, { payload: "x".repeat(50_000) }],
    };
    const handler = chainGetMessagesHandler(fakeDaemon(async () => res));
    const result: any = await handler({ conversation_id: "conv-1", envelope: true });

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.truncated).toBe(true);
    expect(result.content[0].text.length).toBe(8000 * 4);
    expect(result._meta.result_bytes).toBe(Buffer.byteLength(JSON.stringify(res, null, 2), "utf8"));
  });
});
