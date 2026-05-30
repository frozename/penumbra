import { describe, it, expect } from "bun:test";
import { DaemonHttpError } from "../../src/daemon-client.js";
import { formatChainGetResponse, wrapWithSummary } from "../../src/format-summary.js";
import { isEnvelopeResult } from "../../src/responses/envelope.js";
import { chainGetResponseHandler } from "../../src/tools/chain-get-response.js";

type ChainResponsesPayload = {
  responses: Array<{ ts: string; agent: string; text: string }>;
};

function fakeDaemon(
  getChainResponses?: (
    conversationId: string,
    which?: "final" | "all",
  ) => Promise<ChainResponsesPayload>,
): any {
  return {
    getChainResponses:
      getChainResponses ??
      (async () => ({
        responses: [{ ts: "2026-05-01T00:00:00Z", agent: "codex", text: "done" }],
      })),
  };
}

describe("chain_get_response - envelope opt-in", () => {
  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const handler = chainGetResponseHandler(fakeDaemon());
    const result: any = await handler({ conversation_id: "c1", envelope: true });

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.limit).toBe(8000);
    expect(result._meta.result_bytes).toBeGreaterThanOrEqual(0);
    expect(result.content[0].type).toBe("text");
  });

  it("returns the current wrapWithSummary(formatChainGetResponse(payload)) shape when envelope is omitted", async () => {
    const payload: ChainResponsesPayload = {
      responses: [{ ts: "2026-05-01T00:00:00Z", agent: "codex", text: "keep backward compat" }],
    };
    const handler = chainGetResponseHandler(
      fakeDaemon(async (conversationId, which) => {
        expect(conversationId).toBe("c-no-envelope");
        expect(which).toBe("final");
        return payload;
      }),
    );
    const result: any = await handler({ conversation_id: "c-no-envelope", which: "final" });

    expect(isEnvelopeResult(result)).toBe(false);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe(wrapWithSummary(formatChainGetResponse(payload), payload));
  });

  it("keeps not-found response as the existing non-envelope shape even when envelope=true", async () => {
    const err = new DaemonHttpError("daemon /chains/missing/responses: HTTP 404", 404, {
      error: { code: "not_found", message: "no chain events found for conversation" },
    });
    const handler = chainGetResponseHandler(
      fakeDaemon(async () => {
        throw err;
      }),
    );

    const result: any = await handler({ conversation_id: "missing", envelope: true });
    expect(isEnvelopeResult(result)).toBe(false);
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: wrapWithSummary("◑ chain_get_response  not found", {
            error: { code: "not_found", message: "no chain events found for conversation" },
          }),
        },
      ],
    });
  });

  it("truncates envelope text for over-budget payloads and reports full result_bytes", async () => {
    const payload: ChainResponsesPayload = {
      responses: [{ ts: "2026-05-01T00:00:00Z", agent: "codex", text: "x".repeat(100_000) }],
    };
    const handler = chainGetResponseHandler(fakeDaemon(async () => payload));

    const result: any = await handler({ conversation_id: "c-big", envelope: true });

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.truncated).toBe(true);
    expect(result.content[0].text.length).toBe(8000 * 4);
    expect(result._meta.result_bytes).toBe(
      Buffer.byteLength(JSON.stringify(payload, null, 2), "utf8"),
    );
  });
});
