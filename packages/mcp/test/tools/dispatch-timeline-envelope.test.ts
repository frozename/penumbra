import { describe, it, expect } from "bun:test";
import { isEnvelopeResult } from "../../src/responses/envelope.js";
import { dispatchTimelineHandler } from "../../src/tools/dispatch-timeline.js";

function fakeDaemon(getDispatchTimeline?: (handoffId: string) => Promise<unknown>): any {
  return {
    getDispatchTimeline:
      getDispatchTimeline ??
      (async () => ({
        events: [
          {
            kind: "dispatch.start",
            ts: "2026-05-01T00:00:00Z",
            source: "worker",
            handoff_id: "h1",
            worker_id: "worker-1",
            meta: null,
          },
        ],
      })),
  };
}

describe("dispatch_timeline - envelope opt-in", () => {
  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const handler = dispatchTimelineHandler(fakeDaemon());
    const result: any = await handler({ handoff_id: "h1", envelope: true });

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.limit).toBe(8000);
    expect(result._meta.result_bytes).toBeGreaterThanOrEqual(0);
    expect(result.content[0].type).toBe("text");
  });

  it("returns the current raw JSON shape when envelope is omitted", async () => {
    const timeline = { events: [{ kind: "dispatch.start", ts: "2026-05-01T00:00:00Z" }] };
    const handler = dispatchTimelineHandler(fakeDaemon(async () => timeline));
    const result: any = await handler({ handoff_id: "h1" });

    expect(isEnvelopeResult(result)).toBe(false);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe(JSON.stringify(timeline, null, 2));
  });

  it("keeps the non-envelope payload byte-identical when envelope=false", async () => {
    const timeline = { events: [{ kind: "dispatch.start", ts: "2026-05-01T00:00:00Z" }] };
    const handler = dispatchTimelineHandler(fakeDaemon(async () => timeline));
    const result: any = await handler({ handoff_id: "h1", envelope: false });

    expect(isEnvelopeResult(result)).toBe(false);
    expect(result.content[0].text).toBe(JSON.stringify(timeline, null, 2));
  });

  it("truncates envelope text for over-budget payloads and reports full result_bytes", async () => {
    const timeline = {
      events: Array.from({ length: 4000 }, (_, i) => ({
        kind: "dispatch.thought",
        ts: "2026-05-01T00:00:00Z",
        detail: "x".repeat(50) + i,
      })),
    };
    const handler = dispatchTimelineHandler(fakeDaemon(async () => timeline));
    const result: any = await handler({ handoff_id: "h1", envelope: true });

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.truncated).toBe(true);
    expect(result.content[0].text.length).toBe(8000 * 4);
    expect(result._meta.result_bytes).toBe(
      Buffer.byteLength(JSON.stringify(timeline, null, 2), "utf8"),
    );
  });
});
