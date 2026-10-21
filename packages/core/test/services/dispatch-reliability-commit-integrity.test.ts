import { describe, expect, test } from "bun:test";

import {
  classifyDispatchReliability,
  type CommitIntegrityEvidence,
  type DispatchReliabilityHandoff,
  type DispatchReliabilityInput,
} from "@src/services/dispatch-reliability.js";

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

const CLEAN: CommitIntegrityEvidence = {
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  base_is_ancestor: true,
  identity: { name: "Penumbra Worker", email: "worker@example.com" },
  mismatched_commits: [],
};

describe("classifyDispatchReliability commit integrity", () => {
  test("flags a terminal dispatch whose branch head does not descend from the base", () => {
    const report = classifyDispatchReliability(
      baseInput({ commitIntegrity: { ...CLEAN, base_is_ancestor: false } }),
    );

    expect(report.status).toBe("base_not_ancestor");
    expect(report.trustworthy).toBe(false);
    expect(report.recommended_action).toBe("review_manually");
    expect(report.summary).toContain("b".repeat(12));
    expect(report.summary).toContain("a".repeat(12));
  });

  test("flags commits not authored and committed as the dispatch identity", () => {
    const commitIntegrity = { ...CLEAN, mismatched_commits: ["c".repeat(40)] };
    const report = classifyDispatchReliability(baseInput({ commitIntegrity }));

    expect(report.status).toBe("commit_identity_mismatch");
    expect(report.trustworthy).toBe(false);
    expect(report.recommended_action).toBe("review_manually");
    expect(report.summary).toContain("c".repeat(12));
    expect(report.summary).toContain("worker@example.com");
    expect(report.evidence.commit_integrity).toEqual(commitIntegrity);
  });

  test("counts mismatches beyond the listed commits from mismatched_total", () => {
    const commitIntegrity = {
      ...CLEAN,
      mismatched_commits: ["c".repeat(40), "d".repeat(40)],
      mismatched_total: 5,
    };
    const report = classifyDispatchReliability(baseInput({ commitIntegrity }));

    expect(report.status).toBe("commit_identity_mismatch");
    expect(report.trustworthy).toBe(false);
    expect(report.recommended_action).toBe("review_manually");
    expect(report.summary).toContain("5 commit(s)");
    expect(report.summary).toContain("d".repeat(12));
    expect(report.summary).toContain("(+3 more)");
  });

  test("flags a positive mismatched_total even when no commit is listed", () => {
    const report = classifyDispatchReliability(
      baseInput({ commitIntegrity: { ...CLEAN, mismatched_total: 1 } }),
    );

    expect(report.status).toBe("commit_identity_mismatch");
    expect(report.trustworthy).toBe(false);
    expect(report.recommended_action).toBe("review_manually");
  });

  test("flags listed commits when mismatched_total understates them", () => {
    const report = classifyDispatchReliability(
      baseInput({
        commitIntegrity: { ...CLEAN, mismatched_commits: ["c".repeat(40)], mismatched_total: 0 },
      }),
    );

    expect(report.status).toBe("commit_identity_mismatch");
    expect(report.summary).toContain("1 commit(s)");
    expect(report.summary).not.toContain("more)");
  });

  test("accepts a dispatch whose identity check could not run", () => {
    const report = classifyDispatchReliability(
      baseInput({ commitIntegrity: { ...CLEAN, mismatched_total: null } }),
    );

    expect(report.status).toBe("complete");
    expect(report.recommended_action).toBe("accept");
  });

  test("reports base_not_ancestor when both the branch and identity are wrong", () => {
    const report = classifyDispatchReliability(
      baseInput({
        commitIntegrity: {
          ...CLEAN,
          base_is_ancestor: false,
          mismatched_commits: ["c".repeat(40)],
        },
      }),
    );

    expect(report.status).toBe("base_not_ancestor");
  });

  test("accepts a terminal dispatch with clean commit integrity", () => {
    const report = classifyDispatchReliability(baseInput({ commitIntegrity: CLEAN }));

    expect(report.status).toBe("complete");
    expect(report.trustworthy).toBe(true);
    expect(report.recommended_action).toBe("accept");
  });

  test("stays complete when no commit integrity evidence is supplied", () => {
    const report = classifyDispatchReliability(baseInput());

    expect(report.status).toBe("complete");
    expect(report.recommended_action).toBe("accept");
  });

  test("ignores commit integrity for a non-terminal handoff", () => {
    const report = classifyDispatchReliability(
      baseInput({
        handoff: handoff({ status: "dispatched", resolved_at: null }),
        commitIntegrity: { ...CLEAN, base_is_ancestor: false },
      }),
    );

    expect(report.status).toBe("complete");
    expect(report.trustworthy).toBe(false);
    expect(report.recommended_action).toBe("wait");
  });

  test("commit integrity outranks result integrity", () => {
    const withCommit = classifyDispatchReliability(
      baseInput({
        responseCount: 0,
        finalResponseText: "",
        commitIntegrity: { ...CLEAN, base_is_ancestor: false },
      }),
    );
    expect(withCommit.status).toBe("base_not_ancestor");

    const withoutCommit = classifyDispatchReliability(
      baseInput({ responseCount: 0, finalResponseText: "" }),
    );
    expect(withoutCommit.status).toBe("no_agent_output");
  });

  test("missing lifecycle outranks commit integrity", () => {
    const report = classifyDispatchReliability(
      baseInput({
        events: [
          { kind: "proc.spawn", ts: "2026-05-01T00:00:02.000Z" },
          { kind: "proc.exited.resolved", ts: "2026-05-01T00:00:08.000Z" },
          { kind: "dispatch.end", ts: "2026-05-01T00:00:09.000Z", meta: { status: "ok" } },
        ],
        commitIntegrity: { ...CLEAN, base_is_ancestor: false },
      }),
    );
    expect(report.status).toBe("missing_dispatch_start");
  });
});
