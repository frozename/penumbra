import { describe, it, expect } from "bun:test";
import { isEnvelopeResult } from "../../src/responses/envelope.js";
import { dispatchAuditHandler } from "../../src/tools/dispatch-audit.js";

function fakeDaemon(dispatchAudit?: (handoffId: string) => Promise<unknown>): any {
  return {
    dispatchAudit:
      dispatchAudit ??
      (async () => ({
        report: {
          handoff_id: "h1",
          status: "complete",
          terminal: true,
          trustworthy: true,
          summary: "ok",
          missing_events: [],
          evidence: {
            handoff_status: "completed",
            event_count: 4,
            response_count: 1,
            worktree_changed: true,
            reconciled: true,
            watchdog_failed: false,
            cancel_requested: false,
            adapter_streaming: true,
          },
          recommended_action: "accept",
        },
      })),
  };
}

describe("dispatch_audit - envelope opt-in", () => {
  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const handler = dispatchAuditHandler(fakeDaemon());
    const result: any = await handler({ handoff_id: "h1", envelope: true } as any);

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.limit).toBe(8000);
    expect(result._meta.result_bytes).toBeGreaterThanOrEqual(0);
    expect(result.content[0].type).toBe("text");
  });

  it("returns the current raw JSON shape when envelope is omitted", async () => {
    const payload = {
      report: {
        handoff_id: "h1",
        status: "complete",
        terminal: true,
        trustworthy: true,
        summary: "ok",
      },
    };
    const handler = dispatchAuditHandler(fakeDaemon(async () => payload));
    const result: any = await handler({ handoff_id: "h1" });

    expect(isEnvelopeResult(result)).toBe(false);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe(JSON.stringify(payload, null, 2));
  });

  it("keeps the non-envelope payload byte-identical when envelope=false", async () => {
    const payload = {
      report: {
        handoff_id: "h1",
        status: "complete",
        terminal: true,
        trustworthy: true,
        summary: "ok",
      },
    };
    const handler = dispatchAuditHandler(fakeDaemon(async () => payload));
    const result: any = await handler({ handoff_id: "h1", envelope: false } as any);

    expect(isEnvelopeResult(result)).toBe(false);
    expect(result.content[0].text).toBe(JSON.stringify(payload, null, 2));
  });

  it("truncates envelope text for over-budget payloads and reports full result_bytes", async () => {
    const payload = {
      report: {
        handoff_id: "h1",
        status: "complete",
        terminal: true,
        trustworthy: true,
        summary: "x".repeat(50),
        missing_events: Array.from(
          { length: 4000 },
          (_, i) => "missing-" + i + "-" + "x".repeat(50),
        ),
      },
    };
    const handler = dispatchAuditHandler(fakeDaemon(async () => payload));
    const result: any = await handler({ handoff_id: "h1", envelope: true } as any);

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.truncated).toBe(true);
    expect(result.content[0].text.length).toBe(8000 * 4);
    expect(result._meta.result_bytes).toBe(
      Buffer.byteLength(JSON.stringify(payload, null, 2), "utf8"),
    );
  });
});
