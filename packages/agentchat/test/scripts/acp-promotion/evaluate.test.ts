import { describe, expect, test } from "bun:test";

import { evaluatePromotionEvidence } from "../../../scripts/acp-promotion/evaluate.js";
import { PROMOTION_SCENARIOS } from "../../../scripts/acp-promotion/scenarios.js";

const ping = PROMOTION_SCENARIOS.find((s) => s.id === "ping_exact")!;
const write = PROMOTION_SCENARIOS.find((s) => s.id === "write_worktree_file")!;

describe("evaluatePromotionEvidence", () => {
  test("passes exact response with trustworthy reliability", () => {
    const result = evaluatePromotionEvidence({
      agent: "gemini-acp-pro",
      adapter: "stdio-acp",
      scenario: ping,
      handoff_id: "h-1",
      conversation_id: "c-1",
      status: {
        latency_seconds: 12,
        reliability: {
          status: "complete",
          trustworthy: true,
          recommended_action: "accept",
          summary: "ok",
        },
      },
      responses: [{ text: "ACP_PROMOTION_PING_OK\n" }],
      audit: { report: { status: "complete", trustworthy: true, recommended_action: "accept" } },
      timeline: { events: [{ kind: "acp.session.start" }, { kind: "acp.session.end" }] },
      worktree: null,
      artifact: null,
      now: "2026-05-02T00:00:00.000Z",
    });

    expect(result.status).toBe("passed");
    expect(result.trustworthy).toBe(true);
    expect(result.failure_reason).toBeNull();
  });

  test("blocks when audit evidence is missing", () => {
    const result = evaluatePromotionEvidence({
      agent: "gemini-acp-pro",
      adapter: "stdio-acp",
      scenario: ping,
      handoff_id: "h-1",
      conversation_id: "c-1",
      status: {
        latency_seconds: 12,
        reliability: {
          status: "complete",
          trustworthy: true,
          recommended_action: "accept",
          summary: "ok",
        },
      },
      responses: [{ text: "ACP_PROMOTION_PING_OK" }],
      audit: null,
      timeline: { events: [] },
      worktree: null,
      artifact: null,
      now: "2026-05-02T00:00:00.000Z",
    });

    expect(result.status).toBe("blocked");
    expect(result.failure_reason).toBe("missing dispatch audit evidence");
  });

  test("fails when expected artifact content differs", () => {
    const result = evaluatePromotionEvidence({
      agent: "codex-acp-zed",
      adapter: "stdio-acp",
      scenario: write,
      handoff_id: "h-2",
      conversation_id: "c-2",
      status: {
        latency_seconds: 33,
        reliability: {
          status: "complete",
          trustworthy: true,
          recommended_action: "accept",
          summary: "ok",
        },
      },
      responses: [{ text: "ACP_PROMOTION_WRITE_DONE" }],
      audit: { report: { status: "complete", trustworthy: true, recommended_action: "accept" } },
      timeline: { events: [{ kind: "acp.session.start" }, { kind: "terminal.exited" }] },
      worktree: {
        diff_against_main: "diff --git a/acp-promotion-smoke.txt b/acp-promotion-smoke.txt",
      },
      artifact: { path: "acp-promotion-smoke.txt", expected: "ACP_WRITE_OK", actual: "WRONG" },
      now: "2026-05-02T00:00:00.000Z",
    });

    expect(result.status).toBe("failed");
    expect(result.artifact_verified).toBe(false);
    expect(result.failure_reason).toContain("artifact mismatch");
  });
});
