import { expect, test } from "bun:test";

import type { FanoutTaskResult } from "../_shared/fanout.js";

import { resolveAuthoritativeCandidate } from "./candidate.js";

function result(overrides: Partial<FanoutTaskResult> = {}): FanoutTaskResult {
  return {
    ok: true,
    status: "completed",
    label: "candidate",
    index: 0,
    initial_agent: "executor",
    conversation_id: "conversation-1",
    handoff_id: "root-handoff",
    root_handoff_id: "root-handoff",
    latest_handoff_id: "latest-handoff",
    hop_count: 2,
    extra_hops: 1,
    retry_prompt_count: 0,
    hops_incomplete: false,
    hops: [
      {
        handoff_id: "root-handoff",
        status: "completed",
        branch_name: "feature/root",
        to_agent: "executor",
        branch_base: "main",
        parent_handoff_id: null,
        created_ts: "2026-09-13T10:00:00.000Z",
        is_retry: false,
      },
      {
        handoff_id: "latest-handoff",
        status: "completed",
        branch_name: "feature/latest",
        to_agent: "executor",
        branch_base: "feature/root",
        parent_handoff_id: "root-handoff",
        created_ts: "2026-09-13T10:01:00.000Z",
        is_retry: true,
      },
    ],
    branch_name: "feature/root",
    branch_base: "main",
    parent_handoff_id: null,
    response_text: "CHECK_RESULT: PASS",
    final_agent: "executor",
    reliability_status: "complete",
    reliability_trustworthy: true,
    reliability_action: "accept",
    latest_reliability_status: "complete",
    latest_reliability_trustworthy: true,
    latest_reliability_action: "accept",
    retry_count: 0,
    error_code: null,
    error_summary: null,
    ...overrides,
  };
}

test("accepts a trustworthy latest hop even when root reliability is untrustworthy", () => {
  const resolved = resolveAuthoritativeCandidate(
    result({ reliability_trustworthy: false, ok: false }),
  );
  expect(resolved).toEqual({
    ok: true,
    candidate: { branch: "feature/latest", handoffId: "latest-handoff" },
  });
});

test("rejects an untrustworthy latest hop even when root reliability is trustworthy", () => {
  const resolved = resolveAuthoritativeCandidate(result({ latest_reliability_trustworthy: false }));
  expect(resolved).toEqual({
    ok: false,
    reason: "candidate_latest_reliability_untrustworthy",
  });
});

test("rejects an unaudited latest hop", () => {
  const resolved = resolveAuthoritativeCandidate(result({ latest_reliability_trustworthy: null }));
  expect(resolved).toEqual({
    ok: false,
    reason: "candidate_latest_reliability_unverified",
  });
});
