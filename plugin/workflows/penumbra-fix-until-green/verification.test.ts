import { expect, test } from "bun:test";

import { emptyRecall } from "../_shared/test-helpers.js";
import { DEFAULT_INSPECT_SHA, type InspectConfig, stageTestCtx } from "./stage-test-helpers.js";
import { buildVerifyPrompt, CheckVerifySchema, runVerifyCheck } from "./verification.js";

function ctxWithVerifier(
  responseText: string | null,
  opts: {
    dispatchThrows?: boolean;
    awaitThrows?: boolean;
    inspect?: InspectConfig;
    inspectUnavailable?: boolean;
    candidateBranch?: string;
    rootReliability?: "good" | "bad";
    latestReliability?: "good" | "bad";
    persistedBranchBase?: string;
  } = {},
): ReturnType<typeof stageTestCtx> {
  return stageTestCtx(responseText, {
    chainStartThrows: opts.dispatchThrows,
    awaitThrows: opts.awaitThrows,
    inspect: opts.inspect,
    inspectUnavailable: opts.inspectUnavailable,
    candidateBranch: opts.candidateBranch,
    rootReliability: opts.rootReliability,
    latestReliability: opts.latestReliability,
    persistedBranchBase: opts.persistedBranchBase,
  });
}

function jsonBlock(obj: unknown): string {
  const value =
    obj && typeof obj === "object" && !Array.isArray(obj)
      ? {
          candidate_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          checkout_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ...obj,
        }
      : obj;
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

function rawJsonBlock(obj: unknown): string {
  return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
}

// ---------------------------------------------------------------------------
// buildVerifyPrompt
// ---------------------------------------------------------------------------

test("buildVerifyPrompt includes the check command and candidate branch", () => {
  const prompt = buildVerifyPrompt({
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
  });
  expect(prompt).toContain("bun run typecheck");
  expect(prompt).toContain("feature/candidate");
  expect(prompt).toContain("handoff-1");
  expect(prompt).toContain("git rev-parse --verify");
  expect(prompt).toContain("git rev-parse --verify HEAD");
});

test("buildVerifyPrompt does not manufacture an expected commit", () => {
  const prompt = buildVerifyPrompt({
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
  });
  expect(prompt).toContain("none is supplied");
});

test("buildVerifyPrompt includes the parity command when parityCheck is set", () => {
  const prompt = buildVerifyPrompt({
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    parityCheck: "bun run check:ci",
  });
  expect(prompt).toContain("bash -c 'bun run check:ci'");
  expect(prompt).toContain("parity_exit");
});

test("buildVerifyPrompt carries no parity instructions without parityCheck", () => {
  const prompt = buildVerifyPrompt({
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
  });
  expect(prompt).not.toContain("parity_exit");
  expect(prompt).not.toContain("PARITY command");
});

test("buildVerifyPrompt with parity sources failure evidence from the parity run", () => {
  const prompt = buildVerifyPrompt({
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    parityCheck: "bun run check:ci",
  });
  expect(prompt).toContain("failing_segment");
  expect(prompt).toContain("output_tail");
  expect(prompt).toContain("PARITY run");
});

test("buildVerifyPrompt tells the verifier to poll the parity command until it exits", () => {
  const prompt = buildVerifyPrompt({
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    parityCheck: "bun run check:ci",
  });
  // A single shell call may be capped below the parity run's runtime, so the
  // verifier must background and poll rather than ask for a longer timeout.
  expect(prompt).toContain("background");
  expect(prompt).toContain("poll");
  expect(prompt).toContain("before the PARITY command has exited");
  expect(prompt).not.toContain("timeout of at least");
});

// ---------------------------------------------------------------------------
// runVerifyCheck dispatch contract
// ---------------------------------------------------------------------------

test("dispatches verifier with task_type review_adversarial, use_worktree, branch_base", async () => {
  const { ctx, starts, timeouts } = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }));
  await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier-agent",
    timeoutMs: 60000,
  });
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({
    initial_agent: "verifier-agent",
    task_type: "review_adversarial",
    use_worktree: true,
    branch_base: DEFAULT_INSPECT_SHA,
    project_id: "penumbra",
    isolated_install: true,
    max_hops: 1,
    tool_free: true,
  });
  expect(timeouts).toEqual([60000]);
});

// ---------------------------------------------------------------------------
// runVerifyCheck outcomes
// ---------------------------------------------------------------------------

test("returns passed when ran:true and check_exit:0", async () => {
  const { ctx } = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }));
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("passed");
  expect(outcome.result?.ran).toBe(true);
  expect(outcome.result?.check_exit).toBe(0);
  expect(outcome.fail_output).toBe("");
});

test("rejects a valid root verifier report for a trustworthy latest child", async () => {
  const mismatched = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }), {
    rootReliability: "bad",
    latestReliability: "good",
  });
  const mismatchedOutcome = await runVerifyCheck(mismatched.ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
    projectId: "penumbra",
  });
  expect(mismatchedOutcome.status).toBe("unavailable");
  expect(mismatchedOutcome.verifier_handoff_id).toBe("stage-latest");
  expect(mismatchedOutcome.fail_output).toContain("response identity");
});

test("rejects untrustworthy latest-hop reliability even when root reliability is trustworthy", async () => {
  const rejected = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }), {
    rootReliability: "good",
    latestReliability: "bad",
  });
  const rejectedOutcome = await runVerifyCheck(rejected.ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
    projectId: "penumbra",
  });
  expect(rejectedOutcome.status).toBe("unavailable");
  expect(rejectedOutcome.fail_output).toContain("latest");
});

test("does not accept ran:true and check_exit:0 without measured commit identities", async () => {
  const { ctx } = ctxWithVerifier(rawJsonBlock({ ran: true, check_exit: 0 }));
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
  expect(outcome.fail_output).toContain("untrusted");
});

test("fails when measured candidate and verifier checkout commits differ", async () => {
  const { ctx } = ctxWithVerifier(
    jsonBlock({
      ran: true,
      check_exit: 0,
      candidate_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      checkout_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }),
  );
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("failed");
  expect(outcome.fail_output).toContain("target mismatch");
});

test("returns failed when ran:true and check_exit nonzero", async () => {
  const { ctx } = ctxWithVerifier(
    jsonBlock({ ran: true, check_exit: 1, failing_segment: "typecheck", output_tail: "error" }),
  );
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("failed");
  expect(outcome.fail_output).toContain("typecheck");
  expect(outcome.fail_output).toContain("error");
});

test("returns failed when parity is configured and parity_exit is nonzero despite check_exit 0", async () => {
  const { ctx } = ctxWithVerifier(
    jsonBlock({
      ran: true,
      check_exit: 0,
      parity_exit: 1,
      output_tail: "lint:strict failed",
    }),
  );
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
    parityCheck: "bun run check:ci",
  });
  expect(outcome.status).toBe("failed");
  expect(outcome.fail_output).toContain("parity_exit");
});

test("returns passed when parity is configured and parity_exit is 0", async () => {
  const { ctx } = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0, parity_exit: 0 }));
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
    parityCheck: "bun run check:ci",
  });
  expect(outcome.status).toBe("passed");
});

test("fails closed when parity is configured but parity_exit is omitted", async () => {
  const { ctx } = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }));
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
    parityCheck: "bun run check:ci",
  });
  expect(outcome.status).toBe("failed");
  expect(outcome.fail_output).toContain("parity_exit");
});

test("ignores a reported parity_exit when parity is not configured", async () => {
  const { ctx } = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0, parity_exit: 7 }));
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("passed");
});

test("returns failed (not_run) when ran:false", async () => {
  const { ctx } = ctxWithVerifier(
    jsonBlock({ ran: false, check_exit: -1, notes: "could not locate worktree" }),
  );
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("failed");
  expect(outcome.result?.ran).toBe(false);
});

test("returns unavailable when dispatch throws", async () => {
  const { ctx } = ctxWithVerifier(null, { dispatchThrows: true });
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
  expect(outcome.verifier_handoff_id).toBeNull();
});

test("returns unavailable when awaitChain throws", async () => {
  const { ctx } = ctxWithVerifier(null, { awaitThrows: true });
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
  expect(outcome.verifier_handoff_id).toBe("stage-handoff");
});

test("returns unavailable when response is empty", async () => {
  const { ctx } = ctxWithVerifier("");
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
});

test("returns unavailable when response is unparseable", async () => {
  const { ctx } = ctxWithVerifier("not json at all");
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
  expect(outcome.fail_output).toContain("untrusted");
});

test("returns unavailable when response is valid JSON but wrong schema", async () => {
  const { ctx } = ctxWithVerifier(jsonBlock({ ran: "yes", check_exit: "zero" }));
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
});

// ---------------------------------------------------------------------------
// CheckVerifySchema
// ---------------------------------------------------------------------------

test("CheckVerifySchema accepts a valid result", () => {
  const parsed = CheckVerifySchema.safeParse({
    ran: true,
    check_exit: 0,
    candidate_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    checkout_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  expect(parsed.success).toBe(true);
});

test("CheckVerifySchema rejects a result without measured commit identities", () => {
  const parsed = CheckVerifySchema.safeParse({ ran: true, check_exit: 0 });
  expect(parsed.success).toBe(false);
});

test("CheckVerifySchema rejects missing ran", () => {
  const parsed = CheckVerifySchema.safeParse({ check_exit: 0 });
  expect(parsed.success).toBe(false);
});

test("CheckVerifySchema rejects missing check_exit", () => {
  const parsed = CheckVerifySchema.safeParse({ ran: true });
  expect(parsed.success).toBe(false);
});

test("CheckVerifySchema rejects unknown keys", () => {
  const parsed = CheckVerifySchema.safeParse({ ran: true, check_exit: 0, extra: true });
  expect(parsed.success).toBe(false);
});

test("CheckVerifySchema accepts an optional integer parity_exit", () => {
  const parsed = CheckVerifySchema.safeParse({
    ran: true,
    check_exit: 0,
    candidate_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    checkout_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    parity_exit: 0,
  });
  expect(parsed.success).toBe(true);
});

// ---------------------------------------------------------------------------
// Inspection binding: pre-dispatch inspection fail-closed
// ---------------------------------------------------------------------------

test("fails closed when worktreeInspect is unavailable", async () => {
  const { ctx } = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }), {
    inspectUnavailable: true,
  });
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
  expect(outcome.fail_output).toContain("inspect");
  expect(outcome.verifier_handoff_id).toBeNull();
});

test("fails closed when pre-inspection returns null", async () => {
  const { ctx } = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }), {
    inspect: { pre: "missing" },
  });
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
  expect(outcome.fail_output).toContain("inspect");
});

test("fails closed when pre-inspection throws", async () => {
  const { ctx } = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }), {
    inspect: { pre: "throws" },
  });
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
  expect(outcome.fail_output).toContain("inspect");
});

test("fails closed when pre-inspection reports dirty worktree", async () => {
  const { ctx } = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }), {
    inspect: { pre: "dirty" },
  });
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
  expect(outcome.fail_output).toContain("dirty");
});

test("fails closed when pre-inspection handoff identity mismatches", async () => {
  const { ctx } = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }), {
    inspect: { pre: "wrong_handoff" },
  });
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
  expect(outcome.fail_output).toContain("handoff");
});

test("fails closed when pre-inspection branch identity mismatches", async () => {
  const { ctx } = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }), {
    inspect: { pre: "wrong_branch" },
  });
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
  expect(outcome.fail_output).toContain("branch");
});

test("fails closed when pre-inspection HEAD SHA is not a full 40/64-hex id", async () => {
  const { ctx } = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }), {
    inspect: { pre: "malformed_sha" },
  });
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
  expect(outcome.fail_output).toContain("sha");
});

test("malformed inspection objects return evidence-bearing unavailable instead of throwing", async () => {
  const fixture = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }));
  fixture.ctx.worktreeInspect = () => Promise.resolve({} as never);
  const outcome = await runVerifyCheck(fixture.ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
    projectId: "penumbra",
  }).catch((error: unknown) => ({ status: "threw", fail_output: String(error) }));
  expect(outcome.status).toBe("unavailable");
  expect(outcome.fail_output).toContain("inspection");
});

test("rejects every inspection truncation flag before dispatch", async () => {
  for (const flag of ["diff_against_main", "branch_log", "total"] as const) {
    const fixture = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }));
    const inspection = await fixture.ctx.worktreeInspect?.("handoff-1");
    if (!inspection) throw new Error("test inspection missing");
    inspection.truncation[flag] = true;
    fixture.ctx.worktreeInspect = () => Promise.resolve(inspection);
    const outcome = await runVerifyCheck(fixture.ctx, {
      check: "bun run typecheck",
      candidateBranch: "feature/candidate",
      candidateHandoffId: "handoff-1",
      verifierAgent: "verifier",
      timeoutMs: 60000,
      projectId: "penumbra",
    });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.fail_output).toContain("truncation");
    expect(fixture.starts).toEqual([]);
  }
});

test("requires created status, matching project, strict false dirty, and required strings", async () => {
  const mutations: ((inspection: Record<string, unknown>) => void)[] = [
    (inspection) => {
      (inspection.worktree as Record<string, unknown>).status = "merged";
    },
    (inspection) => {
      (inspection.worktree as Record<string, unknown>).projectId = "other-project";
    },
    (inspection) => {
      inspection.dirty = "false";
    },
    (inspection) => {
      inspection.diff_against_main = null;
    },
  ];
  for (const mutate of mutations) {
    const fixture = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }));
    const inspection = await fixture.ctx.worktreeInspect?.("handoff-1");
    if (!inspection) throw new Error("test inspection missing");
    mutate(inspection);
    fixture.ctx.worktreeInspect = () => Promise.resolve(inspection);
    const outcome = await runVerifyCheck(fixture.ctx, {
      check: "bun run typecheck",
      candidateBranch: "feature/candidate",
      candidateHandoffId: "handoff-1",
      verifierAgent: "verifier",
      timeoutMs: 60000,
      projectId: "penumbra",
    });
    expect(outcome.status).toBe("unavailable");
    expect(fixture.starts).toEqual([]);
  }
});

test("binds verifier persisted branch_base and inspected checkout to the host SHA", async () => {
  const wrongBase = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }), {
    persistedBranchBase: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
  const wrongBaseOutcome = await runVerifyCheck(wrongBase.ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
    projectId: "penumbra",
  });
  expect(wrongBaseOutcome.status).toBe("unavailable");
  expect(wrongBaseOutcome.fail_output).toContain("branch_base");

  const wrongHost = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }));
  const originalInspect = wrongHost.ctx.worktreeInspect;
  wrongHost.ctx.worktreeInspect = async (handoffId) => {
    const inspection = await originalInspect?.(handoffId);
    if (inspection && handoffId.startsWith("stage-")) {
      inspection.head_sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      inspection.worktree.branchName = "stage/branch";
      inspection.branch_name = "stage/branch";
    }
    return inspection ?? null;
  };
  const wrongHostOutcome = await runVerifyCheck(wrongHost.ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
    projectId: "penumbra",
  });
  expect(wrongHostOutcome.status).toBe("unavailable");
  expect(wrongHostOutcome.fail_output).toContain("HEAD");
});

// ---------------------------------------------------------------------------
// Inspection binding: verifier dispatch uses host-observed SHA as branch_base
// ---------------------------------------------------------------------------

test("verifier dispatch uses the host-observed HEAD SHA as branch_base, not the branch name", async () => {
  const { ctx, starts } = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }));
  await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier-agent",
    timeoutMs: 60000,
  });
  expect(starts).toHaveLength(1);
  expect(starts[0]?.branch_base).toBe(DEFAULT_INSPECT_SHA);
  expect(starts[0]?.branch_base).not.toBe("feature/candidate");
});

// ---------------------------------------------------------------------------
// Inspection binding: host identity comparison
// ---------------------------------------------------------------------------

test("fails when verifier candidate_commit does not match host-observed SHA", async () => {
  const { ctx } = ctxWithVerifier(
    jsonBlock({
      ran: true,
      check_exit: 0,
      candidate_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      checkout_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }),
  );
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("failed");
  expect(outcome.fail_output).toContain("host");
});

test("fails when verifier checkout_commit does not match host-observed SHA", async () => {
  const { ctx } = ctxWithVerifier(
    jsonBlock({
      ran: true,
      check_exit: 0,
      candidate_commit: "cccccccccccccccccccccccccccccccccccccccc",
      checkout_commit: "cccccccccccccccccccccccccccccccccccccccc",
    }),
  );
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("failed");
  expect(outcome.fail_output).toContain("host");
});

// ---------------------------------------------------------------------------
// Inspection binding: post-verifier inspection fail-closed
// ---------------------------------------------------------------------------

test("fails closed when post-inspection HEAD changed after verifier", async () => {
  const { ctx } = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }), {
    inspect: { postSha: "cccccccccccccccccccccccccccccccccccccccc" },
  });
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
  expect(outcome.fail_output).toContain("changed");
});

test("fails closed when post-inspection reports dirty worktree", async () => {
  const { ctx } = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }), {
    inspect: { post: "dirty" },
  });
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
  expect(outcome.fail_output).toContain("dirty");
});

test("fails closed when post-inspection returns null", async () => {
  const { ctx } = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }), {
    inspect: { post: "missing" },
  });
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
  expect(outcome.fail_output).toContain("inspect");
});

test("passes when pre and post inspections are clean and commits match host SHA", async () => {
  const { ctx } = ctxWithVerifier(jsonBlock({ ran: true, check_exit: 0 }));
  const outcome = await runVerifyCheck(ctx, {
    check: "bun run typecheck",
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    verifierAgent: "verifier",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("passed");
  expect(outcome.fail_output).toBe("");
});

// Unused import suppression
void emptyRecall;
