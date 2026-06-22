import { describe, expect, test } from "bun:test";

import type { AcpPromotionRunResult } from "../../../scripts/acp-promotion/types.js";

import {
  renderPromotionJsonl,
  renderPromotionMarkdown,
} from "../../../scripts/acp-promotion/report.js";

const rows: AcpPromotionRunResult[] = [
  {
    ts: "2026-05-02T00:00:00.000Z",
    agent: "gemini-acp-pro",
    adapter: "stdio-acp",
    scenario: "ping_exact",
    status: "passed",
    handoff_id: "h-1",
    conversation_id: "c-1",
    latency_seconds: 12,
    reliability_status: "complete",
    trustworthy: true,
    recommended_action: "accept",
    final_response: "ACP_PROMOTION_PING_OK",
    expected_artifact: null,
    artifact_verified: null,
    failure_reason: null,
  },
  {
    ts: "2026-05-02T00:01:00.000Z",
    agent: "codex-acp-zed",
    adapter: "stdio-acp",
    scenario: "write_worktree_file",
    status: "failed",
    handoff_id: "h-2",
    conversation_id: "c-2",
    latency_seconds: 44,
    reliability_status: "complete",
    trustworthy: true,
    recommended_action: "accept",
    final_response: "DONE",
    expected_artifact: "acp-promotion-smoke.txt",
    artifact_verified: false,
    failure_reason: "artifact mismatch: acp-promotion-smoke.txt",
  },
];

describe("ACP promotion reports", () => {
  test("renders one JSON object per line", () => {
    const jsonl = renderPromotionJsonl(rows);
    expect(jsonl.trim().split("\n")).toHaveLength(2);
    const firstRow = JSON.parse(jsonl.trim().split("\n")[0]!) as AcpPromotionRunResult;
    expect(firstRow.agent).toBe("gemini-acp-pro");
  });

  test("renders Markdown grouped by agent and scenario", () => {
    const md = renderPromotionMarkdown(rows, { generatedAt: "2026-05-02T00:02:00.000Z" });
    expect(md).toContain("# ACP Promotion Report");
    expect(md).toContain("| gemini-acp-pro | ping_exact | passed | complete | true | accept |");
    expect(md).toContain("artifact mismatch: acp-promotion-smoke.txt");
    expect(md).toContain("No routing changes were applied by this report.");
  });
});
