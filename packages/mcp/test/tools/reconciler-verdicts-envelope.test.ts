import { describe, it, expect } from "bun:test";
import { isEnvelopeResult } from "../../src/responses/envelope.js";
import { reconcilerVerdictsHandler } from "../../src/tools/reconciler-verdicts.js";

function fakeDaemon(reconcilerVerdicts?: (input: unknown) => Promise<unknown>): any {
  return {
    reconcilerVerdicts:
      reconcilerVerdicts ??
      (async () => ({ verdicts: [{ handoff_id: "h-1", verdict: "passed" }] })),
  };
}

describe("reconciler_verdicts - envelope opt-in", () => {
  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const handler = reconcilerVerdictsHandler(fakeDaemon());
    const result: any = await handler({ envelope: true });

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.limit).toBe(8000);
    expect(result._meta.result_bytes).toBeGreaterThanOrEqual(0);
    expect(result.content[0].type).toBe("text");
  });

  it("returns the current raw JSON shape when envelope is omitted", async () => {
    const out = { verdicts: [{ handoff_id: "h-1", verdict: "passed" }] };
    const handler = reconcilerVerdictsHandler(fakeDaemon(async () => out));
    const result: any = await handler({});

    expect(isEnvelopeResult(result)).toBe(false);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe(JSON.stringify(out, null, 2));
  });

  it("keeps the non-envelope payload byte-identical when envelope=false", async () => {
    const out = { verdicts: [{ handoff_id: "h-1", verdict: "passed" }] };
    const handler = reconcilerVerdictsHandler(fakeDaemon(async () => out));
    const result: any = await handler({ envelope: false });

    expect(isEnvelopeResult(result)).toBe(false);
    expect(result.content[0].text).toBe(JSON.stringify(out, null, 2));
  });

  it("truncates envelope text for over-budget payloads and reports full result_bytes", async () => {
    const out = {
      verdicts: Array.from({ length: 4000 }, (_, i) => ({
        handoff_id: "h-" + i,
        verdict: "passed",
        detail: "x".repeat(50) + i,
      })),
    };
    const handler = reconcilerVerdictsHandler(fakeDaemon(async () => out));
    const result: any = await handler({ envelope: true });

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.truncated).toBe(true);
    expect(result.content[0].text.length).toBe(8000 * 4);
    expect(result._meta.result_bytes).toBe(Buffer.byteLength(JSON.stringify(out, null, 2), "utf8"));
  });
});
