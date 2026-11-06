import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import type { FanoutTaskResult } from "../_shared/fanout.js";

import { makeRoundRecord, type RoundRecord } from "./result.js";

function fakeFanoutResult(overrides: Partial<FanoutTaskResult> = {}): FanoutTaskResult {
  return {
    ok: true,
    status: "completed",
    label: "task-0",
    index: 0,
    initial_agent: "executor",
    conversation_id: "conv-1",
    handoff_id: "handoff-1",
    root_handoff_id: "handoff-1",
    latest_handoff_id: "handoff-1",
    hop_count: 1,
    extra_hops: 0,
    retry_prompt_count: 0,
    hops_incomplete: false,
    hops: [],
    branch_name: "feature/branch-1",
    branch_base: "main",
    parent_handoff_id: null,
    response_text: "response",
    final_agent: "executor",
    reliability_status: "complete",
    reliability_trustworthy: true,
    reliability_action: "accept",
    latest_reliability_status: "complete",
    latest_reliability_trustworthy: true,
    latest_reliability_action: "accept",
    autocommitted: true,
    autocommit_sha: "c".repeat(40),
    retry_count: 0,
    error_code: null,
    error_summary: null,
    cancel_requested: false,
    ...overrides,
  };
}

test("makeRoundRecord matches the pinned autocommit golden", async () => {
  const result = fakeFanoutResult();
  const record = makeRoundRecord({
    round: 2,
    agent: "executor",
    result,
    dispatchOk: true,
    reason: "check_passed",
    checkPassed: true,
    checkVerifyStatus: "passed",
    checkExit: 0,
    verified: true,
    ciParity: false,
    passed: true,
    candidateBranch: "agent/h-golden",
    candidateHandoffId: "h-golden",
  });

  const text = await readFile(new URL("./round-record.golden.json", import.meta.url), "utf8").catch(
    () => null,
  );
  expect(text).not.toBeNull();
  const parsed: unknown = JSON.parse(text!);
  expect(parsed).toBeObject();
  const golden = parsed as RoundRecord;
  expect(golden.autocommitted).toBe(true);
  expect(record).toEqual(golden);
});
