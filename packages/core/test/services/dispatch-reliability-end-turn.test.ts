import { describe, expect, test } from "bun:test";

import {
  classifyDispatchReliability,
  type DispatchReliabilityHandoff,
  type DispatchReliabilityInput,
} from "@src/services/dispatch-reliability.js";

const CHECK_RESULT_PROMPT = [
  "Implement the evidence renderer.",
  "",
  "When done, run this check in the repo by spawning bash with the command as a single argument:",
  "    bash -c 'bun test'",
  "If it fails, fix and re-run until it passes or you cannot make further progress. Commit your work on the worktree branch.",
  "IMPORTANT: BEGIN your FINAL message with a line that is exactly `CHECK_RESULT: PASS` or `CHECK_RESULT: FAIL`. If FAIL, follow it with the last ~50 lines of the check output inside a fenced ``` block.",
].join("\n");

const MID_TASK_RESPONSE = "Steps 1 and 2 are done.\n\nNow let me write the evidence renderer file.";

function handoff(overrides: Partial<DispatchReliabilityHandoff> = {}): DispatchReliabilityHandoff {
  return {
    handoff_id: "h-1",
    status: "completed",
    ts: "2026-05-01T00:00:00.000Z",
    resolved_at: "2026-05-01T00:00:10.000Z",
    cancel_requested_at: null,
    chain_task_type: "implement_small",
    use_worktree: 1,
    ...overrides,
  };
}

function baseInput(overrides: Partial<DispatchReliabilityInput> = {}): DispatchReliabilityInput {
  return {
    handoff: handoff(),
    events: [
      { kind: "dispatch.start", ts: "2026-05-01T00:00:01.000Z" },
      { kind: "proc.spawn", ts: "2026-05-01T00:00:02.000Z" },
      { kind: "proc.exited.resolved", ts: "2026-05-01T00:00:08.000Z" },
      { kind: "dispatch.end", ts: "2026-05-01T00:00:09.000Z", meta: { status: "ok" } },
    ],
    responseCount: 1,
    finalResponseText: "DONE",
    worktreeChanged: true,
    dispatchEndCommitted: true,
    reconciled: true,
    adapterStreaming: true,
    now: new Date("2026-05-01T00:00:20.000Z"),
    staleAfterMs: 120_000,
    ...overrides,
  };
}

describe("classifyDispatchReliability end_turn_without_return_block", () => {
  test("flags a completed turn whose final response lacks the prescribed CHECK_RESULT line", () => {
    const report = classifyDispatchReliability(
      baseInput({ dispatchPrompt: CHECK_RESULT_PROMPT, finalResponseText: MID_TASK_RESPONSE }),
    );

    expect(report.status).toBe("end_turn_without_return_block");
    expect(report.trustworthy).toBe(false);
    expect(report.recommended_action).toBe("retry");
    expect(report.summary).toContain("CHECK_RESULT");
  });

  test.each([
    ["a PASS line", "CHECK_RESULT: PASS\nall green"],
    ["a FAIL line", "CHECK_RESULT: FAIL\n```\n1 fail\n```"],
    ["an indented marker after narration", "Ran the check.\n   check_result: pass"],
  ])("accepts a final response that carries %s", (_label, finalResponseText) => {
    const report = classifyDispatchReliability(
      baseInput({ dispatchPrompt: CHECK_RESULT_PROMPT, finalResponseText }),
    );

    expect(report.status).toBe("complete");
    expect(report.trustworthy).toBe(true);
    expect(report.recommended_action).toBe("accept");
  });

  test.each([
    [
      "names the marker and the words return block in prose",
      "Fix the CHECK_RESULT parser in check-parse.ts; its return block handling drops the final message.",
    ],
    [
      "quotes the instruction mid-line",
      "Workers are told: IMPORTANT: BEGIN your FINAL message with a line that is exactly `CHECK_RESULT: PASS` or `CHECK_RESULT: FAIL`.",
    ],
    [
      "quotes the instruction in an indented block",
      "The round prompt ends with:\n    IMPORTANT: BEGIN your FINAL message with a line that is exactly `CHECK_RESULT: PASS` or `CHECK_RESULT: FAIL`.",
    ],
  ])("does not flag a prompt that merely %s", (_label, dispatchPrompt) => {
    const report = classifyDispatchReliability(
      baseInput({ dispatchPrompt, finalResponseText: MID_TASK_RESPONSE }),
    );

    expect(report.status).toBe("complete");
    expect(report.recommended_action).toBe("accept");
  });

  test("flags an implementation task whose dispatch.end recorded a dirty worktree", () => {
    const report = classifyDispatchReliability(
      baseInput({ dispatchEndDirty: true, finalResponseText: MID_TASK_RESPONSE }),
    );

    expect(report.status).toBe("end_turn_without_return_block");
    expect(report.trustworthy).toBe(false);
    expect(report.recommended_action).toBe("retry");
    expect(report.summary).toContain("uncommitted");
  });

  test("flags a dirty worktree for an untyped dispatch that runs in a worktree", () => {
    const report = classifyDispatchReliability(
      baseInput({ handoff: handoff({ chain_task_type: null }), dispatchEndDirty: true }),
    );

    expect(report.status).toBe("end_turn_without_return_block");
  });

  test("does not flag a dirty worktree for a non-implementation task", () => {
    const report = classifyDispatchReliability(
      baseInput({
        handoff: handoff({ chain_task_type: "review_adversarial" }),
        dispatchEndDirty: true,
      }),
    );

    expect(report.status).toBe("complete");
    expect(report.recommended_action).toBe("accept");
  });

  test("keeps a normal completion as complete/accept when the new inputs are clean", () => {
    const report = classifyDispatchReliability(
      baseInput({
        dispatchPrompt: CHECK_RESULT_PROMPT,
        finalResponseText: "CHECK_RESULT: PASS",
        dispatchEndDirty: false,
      }),
    );

    expect(report.status).toBe("complete");
    expect(report.trustworthy).toBe(true);
    expect(report.recommended_action).toBe("accept");
  });

  test("only judges completed handoffs", () => {
    const failed = classifyDispatchReliability(
      baseInput({
        handoff: handoff({ status: "failed" }),
        dispatchPrompt: CHECK_RESULT_PROMPT,
        finalResponseText: MID_TASK_RESPONSE,
        dispatchEndDirty: true,
      }),
    );
    const running = classifyDispatchReliability(
      baseInput({
        handoff: handoff({ status: "dispatched", resolved_at: null }),
        dispatchPrompt: CHECK_RESULT_PROMPT,
        finalResponseText: MID_TASK_RESPONSE,
        dispatchEndDirty: true,
      }),
    );

    expect(failed.status).not.toBe("end_turn_without_return_block");
    expect(running.status).toBe("complete");
    expect(running.recommended_action).toBe("wait");
  });

  test("leaves earlier integrity findings in charge", () => {
    const noOutput = classifyDispatchReliability(
      baseInput({
        dispatchPrompt: CHECK_RESULT_PROMPT,
        responseCount: 0,
        finalResponseText: null,
        dispatchEndDirty: true,
      }),
    );
    const toolFailure = classifyDispatchReliability(
      baseInput({
        events: [
          { kind: "dispatch.start", ts: "2026-05-01T00:00:01.000Z" },
          { kind: "proc.spawn", ts: "2026-05-01T00:00:02.000Z" },
          { kind: "agent.tool_call.failed", ts: "2026-05-01T00:00:05.000Z" },
          { kind: "dispatch.end", ts: "2026-05-01T00:00:09.000Z" },
        ],
        dispatchEndCommitted: false,
        dispatchEndDirty: true,
      }),
    );

    expect(noOutput.status).toBe("no_agent_output");
    expect(toolFailure.status).toBe("tool_failure_with_end_turn");
  });
});
