import { describe, expect, test } from "bun:test";

import {
  classifyDispatchReliability,
  type DispatchReliabilityEvent,
  type DispatchReliabilityInput,
  type DispatchReliabilityStatus,
} from "@src/services/dispatch-reliability.js";

const START: DispatchReliabilityEvent = { kind: "dispatch.start", ts: "2026-05-01T00:00:01.000Z" };
const SPAWN: DispatchReliabilityEvent = { kind: "proc.spawn", ts: "2026-05-01T00:00:02.000Z" };
const EXITED: DispatchReliabilityEvent = {
  kind: "proc.exited.resolved",
  ts: "2026-05-01T00:00:08.000Z",
};
const END: DispatchReliabilityEvent = {
  kind: "dispatch.end",
  ts: "2026-05-01T00:00:09.000Z",
  meta: { status: "ok" },
};

function worktreeReady(meta: unknown, ts = "2026-05-01T00:00:01.500Z"): DispatchReliabilityEvent {
  return { kind: "dispatch.worktree_ready", ts, meta };
}

function inputWith(
  extra: DispatchReliabilityEvent[],
  overrides: Partial<DispatchReliabilityInput> = {},
): DispatchReliabilityInput {
  return {
    handoff: {
      handoff_id: "h-1",
      status: "completed",
      ts: "2026-05-01T00:00:00.000Z",
      resolved_at: "2026-05-01T00:00:10.000Z",
      cancel_requested_at: null,
      chain_task_type: "implement_small",
      use_worktree: 1,
    },
    events: [START, ...extra, SPAWN, EXITED, END],
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

describe("classifyDispatchReliability git_hooks evidence", () => {
  test("surfaces git_hooks from the dispatch.worktree_ready meta", () => {
    const report = classifyDispatchReliability(
      inputWith([
        worktreeReady({ worktree_mode: "isolated_install", duration_ms: 5, git_hooks: "missing" }),
      ]),
    );
    expect(report.evidence.git_hooks).toBe("missing");
  });

  test("surfaces each known status", () => {
    for (const status of ["not_configured", "missing", "empty", "installed"] as const) {
      const report = classifyDispatchReliability(inputWith([worktreeReady({ git_hooks: status })]));
      expect(report.evidence.git_hooks).toBe(status);
    }
  });

  test("git_hooks leaves status, trustworthy, summary and recommended_action unchanged", () => {
    const cases: {
      overrides: Partial<DispatchReliabilityInput>;
      status: DispatchReliabilityStatus;
    }[] = [
      { overrides: {}, status: "complete" },
      { overrides: { worktreeChanged: false }, status: "no_worktree_activity" },
    ];
    for (const { overrides, status } of cases) {
      const without = classifyDispatchReliability(inputWith([], overrides));
      const withHooks = classifyDispatchReliability(
        inputWith([worktreeReady({ git_hooks: "missing" })], overrides),
      );
      expect(without.status).toBe(status);
      expect(withHooks.status).toBe(without.status);
      expect(withHooks.trustworthy).toBe(without.trustworthy);
      expect(withHooks.summary).toBe(without.summary);
      expect(withHooks.recommended_action).toBe(without.recommended_action);
      expect(withHooks.missing_events).toEqual(without.missing_events);
      expect(withHooks.evidence.git_hooks).toBe("missing");
    }
  });

  test("drops a git_hooks value that is not a known status", () => {
    for (const value of ["/abs/path/.husky/_", 42, null, "MISSING", ""]) {
      const report = classifyDispatchReliability(inputWith([worktreeReady({ git_hooks: value })]));
      expect("git_hooks" in report.evidence).toBe(false);
    }
  });

  test("omits git_hooks when no worktree_ready event carries it", () => {
    const inputs = [
      inputWith([]),
      inputWith([{ kind: "dispatch.worktree_ready", ts: "2026-05-01T00:00:01.500Z" }]),
      inputWith([worktreeReady({ worktree_mode: "symlink_mirror", duration_ms: 5 })]),
      inputWith([worktreeReady("missing")]),
    ];
    for (const input of inputs) {
      expect("git_hooks" in classifyDispatchReliability(input).evidence).toBe(false);
    }
  });

  test("reads only dispatch.worktree_ready events, and the last one wins", () => {
    const last = classifyDispatchReliability(
      inputWith([
        worktreeReady({ git_hooks: "installed" }, "2026-05-01T00:00:01.200Z"),
        worktreeReady({ git_hooks: "missing" }, "2026-05-01T00:00:01.400Z"),
      ]),
    );
    expect(last.evidence.git_hooks).toBe("missing");

    const lastWithout = classifyDispatchReliability(
      inputWith([
        worktreeReady({ git_hooks: "installed" }, "2026-05-01T00:00:01.200Z"),
        worktreeReady({ worktree_mode: "symlink_mirror" }, "2026-05-01T00:00:01.400Z"),
      ]),
    );
    expect("git_hooks" in lastWithout.evidence).toBe(false);

    const otherKind = classifyDispatchReliability(
      inputWith([
        { kind: "agent.note", ts: "2026-05-01T00:00:01.500Z", meta: { git_hooks: "missing" } },
      ]),
    );
    expect("git_hooks" in otherKind.evidence).toBe(false);
  });
});
