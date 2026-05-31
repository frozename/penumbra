import { describe, it, expect } from "bun:test";
import { searchHandler } from "../../src/tools/search.js";
import { isEnvelopeResult } from "../../src/responses/envelope.js";

function fakeDaemon(memorySearch?: (arg: unknown) => Promise<unknown>): any {
  return { memorySearch: memorySearch ?? (async () => ({ hits: [], total: 0 })) };
}

describe("memory_search — envelope opt-in", () => {
  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const handler = searchHandler(fakeDaemon());
    const result: any = await handler({ query: "test", envelope: true });
    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget).toBeDefined();
    expect(result._meta.token_budget.limit).toBe(8000);
    expect(result._meta.result_bytes).toBeGreaterThanOrEqual(0);
    expect(result.content[0].type).toBe("text");
  });

  it("returns the bare TextContentEnvelope (NOT an EnvelopeResult) when envelope is omitted", async () => {
    const handler = searchHandler(fakeDaemon());
    const result: any = await handler({ query: "test" });
    expect(isEnvelopeResult(result)).toBe(false);
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0].type).toBe("text");
  });

  it("does not forward the envelope flag to the daemon", async () => {
    let received: any = "UNSET";
    const handler = searchHandler(
      fakeDaemon(async (arg: unknown) => {
        received = arg;
        return { hits: [] };
      }),
    );
    await handler({ query: "test", envelope: true });
    expect(received).not.toBeNull();
    expect(received.query).toBe("test");
    expect("envelope" in received).toBe(false);
  });

  it("truncates the envelope text and flags it when the result exceeds the budget", async () => {
    // DEFAULT_BUDGET = 8000 tokens → 32000 char limit. A daemon payload whose
    // serialized JSON far exceeds that must come back truncated, with
    // result_bytes still reporting the full pre-truncation source size.
    const big = { hits: [{ body: "x".repeat(50_000) }] };
    const handler = searchHandler(fakeDaemon(async () => big));
    const result: any = await handler({ query: "test", envelope: true });
    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.truncated).toBe(true);
    expect(result.content[0].text.length).toBe(8000 * 4);
    const fullBytes = Buffer.byteLength(JSON.stringify(big, null, 2), "utf8");
    expect(result._meta.result_bytes).toBe(fullBytes);
  });

  it("preserves additive why/source_quote/learned_at/last_verified_at fields in envelope text", async () => {
    const payload = {
      hits: [
        {
          id: "mem-1",
          tier: "t2",
          ts: "2026-05-30T00:00:00.000Z",
          obs_type: "decision",
          title: "Decision title",
          snippet: "short snippet",
          project_id: "p1",
          score: -2.5,
          why: "to prevent stale dispatch false positives",
          source_quote: "event-aware idle threshold required before force-fail",
          learned_at: "2026-05-30T00:01:00.000Z",
          last_verified_at: "2026-05-30T00:02:00.000Z",
        },
      ],
      total: 1,
    };
    const handler = searchHandler(fakeDaemon(async () => payload));
    const result: any = await handler({ query: "dispatch", envelope: true });

    expect(isEnvelopeResult(result)).toBe(true);
    const roundTripped = JSON.parse(result.content[0].text);
    expect(roundTripped).toEqual(payload);
  });
});
