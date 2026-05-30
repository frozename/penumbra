import { describe, it, expect, mock } from "bun:test";
import { DaemonHttpError } from "../../src/daemon-client.js";
import { isEnvelopeResult } from "../../src/responses/envelope.js";
import { formatHandoffGet, wrapWithSummary } from "../../src/format-summary.js";
import { handoffGetHandler } from "../../src/tools/handoff-get.js";

function fakeDaemon(getHandoff?: (handoffId: string) => Promise<unknown>): any {
  return {
    getHandoff:
      getHandoff ??
      (async () => ({
        handoff: {
          handoff_id: "h1",
          ts: "2026-05-01T00:00:00Z",
          status: "completed",
          from_agent: "user",
          to_agent: "codex",
          message: "hello",
          resolution_reason: "done",
        },
      })),
  };
}

describe("handoff_get - envelope opt-in", () => {
  it("returns an EnvelopeResult with token_budget + result_bytes when envelope=true", async () => {
    const handler = handoffGetHandler(fakeDaemon());
    const result: any = await handler({ handoff_id: "h1", envelope: true });

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.limit).toBe(8000);
    expect(result._meta.result_bytes).toBeGreaterThanOrEqual(0);
    expect(result.content[0].type).toBe("text");
  });

  it("returns the current wrapWithSummary(formatHandoffGet(payload)) shape when envelope is omitted", async () => {
    const handoff = {
      handoff_id: "h-no-envelope",
      ts: "2026-05-01T00:00:00Z",
      status: "completed",
      from_agent: "user",
      to_agent: "codex",
      message: "keep backward compat",
      resolution_reason: "done",
    };
    const handler = handoffGetHandler(fakeDaemon(async () => ({ handoff })));
    const result: any = await handler({ handoff_id: "h-no-envelope" });

    expect(isEnvelopeResult(result)).toBe(false);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe(
      wrapWithSummary(formatHandoffGet({ handoff }), { handoff }),
    );
  });

  it("applies compact transform before envelope serialization", async () => {
    const handler = handoffGetHandler(
      fakeDaemon(async () => ({
        handoff: {
          handoff_id: "h-compact",
          ts: "2026-05-01T00:00:00Z",
          status: "failed",
          from_agent: "user",
          to_agent: "codex",
          message: "x".repeat(5000),
          resolution_reason: "a".repeat(1500),
        },
      })),
    );

    const result: any = await handler({ handoff_id: "h-compact", compact: true, envelope: true });
    expect(isEnvelopeResult(result)).toBe(true);
    expect(result.content[0].text).not.toContain('"message":');
  });

  it("keeps not-found response as the existing non-envelope shape even when envelope=true", async () => {
    const err = new DaemonHttpError("daemon /handoffs/missing: HTTP 404", 404, {
      error: { code: "not_found", message: "handoff missing not found" },
    });
    const handler = handoffGetHandler(
      fakeDaemon(async () => {
        throw err;
      }),
    );

    const result: any = await handler({ handoff_id: "missing", envelope: true });
    expect(isEnvelopeResult(result)).toBe(false);
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: wrapWithSummary("◑ handoff  not found", {
            error: { code: "not_found", message: "handoff missing not found" },
          }),
        },
      ],
    });
  });

  it("truncates envelope text for over-budget payloads and reports full result_bytes", async () => {
    const handoff = {
      handoff_id: "h-big",
      ts: "2026-05-01T00:00:00Z",
      status: "completed",
      from_agent: "user",
      to_agent: "codex",
      message: "x".repeat(50_000),
      resolution_reason: "y".repeat(50_000),
    };
    const payload = { handoff };
    const handler = handoffGetHandler(fakeDaemon(async () => ({ handoff })));

    const result: any = await handler({ handoff_id: "h-big", envelope: true });

    expect(isEnvelopeResult(result)).toBe(true);
    expect(result._meta.token_budget.truncated).toBe(true);
    expect(result.content[0].text.length).toBe(8000 * 4);
    expect(result._meta.result_bytes).toBe(
      Buffer.byteLength(JSON.stringify(payload, null, 2), "utf8"),
    );
  });
});
