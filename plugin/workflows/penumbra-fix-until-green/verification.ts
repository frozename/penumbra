import type { WorkflowCtx } from "@penumbra/workflows";

import { z } from "zod";

import { type FanoutTaskResult, runFanout } from "../_shared/fanout.js";
import {
  parseStructured,
  renderJsonContract,
  type SafeParseSchema,
} from "../_shared/structured.js";
import { type CandidateRef, resolveAuthoritativeCandidate } from "./candidate.js";
import { bashCheckCommand, shellQuote } from "./check-parse.js";
import { inspectBoundWorktree, worktreeBindingFailure } from "./worktree-binding.js";

const GitCommitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const CheckVerifySchema = z
  .object({
    ran: z.boolean(),
    check_exit: z.number().int(),
    parity_exit: z.number().int().optional(),
    candidate_commit: GitCommitSchema.nullable(),
    checkout_commit: GitCommitSchema.nullable(),
    failing_segment: z.string().max(1000).optional(),
    output_tail: z.string().max(4000).optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict()
  .superRefine((value, refinement) => {
    if (!value.ran) return;
    if (value.candidate_commit === null) {
      refinement.addIssue({
        code: "custom",
        path: ["candidate_commit"],
        message: "required when ran",
      });
    }
    if (value.checkout_commit === null) {
      refinement.addIssue({
        code: "custom",
        path: ["checkout_commit"],
        message: "required when ran",
      });
    }
  });

export type CheckVerifyResult = z.infer<typeof CheckVerifySchema>;

function checkVerifyExample(withParity: boolean): string {
  return JSON.stringify(
    {
      ran: true,
      check_exit: 0,
      ...(withParity ? { parity_exit: 0 } : {}),
      candidate_commit: "0123456789abcdef0123456789abcdef01234567",
      checkout_commit: "0123456789abcdef0123456789abcdef01234567",
      failing_segment: "",
      output_tail: "",
      notes: "",
    },
    null,
    2,
  );
}

export type VerifyCheckOutcome = {
  status: "passed" | "failed" | "unavailable" | "not_run";
  result: CheckVerifyResult | null;
  verifier_handoff_id: string | null;
  verifier_branch: string | null;
  fail_output: string;
};

export function buildVerifyPrompt(opts: {
  check: string;
  candidateBranch: string;
  candidateHandoffId: string;
  parityCheck?: string;
}): string {
  const candidateRef = `${opts.candidateBranch}^{commit}`;
  return [
    "You are an independent CHECK verifier in a separate fleet worktree. Do not edit, commit, push, or land anything.",
    "",
    "The worker claimed PASS. Do not trust that claim; measure the assigned candidate identity and CHECK.",
    `Candidate branch: ${JSON.stringify(opts.candidateBranch)}`,
    `Candidate handoff id: ${JSON.stringify(opts.candidateHandoffId)}`,
    "",
    "From the assigned verifier worktree, measure both commits with these commands:",
    `    git rev-parse --verify ${shellQuote(candidateRef)}`,
    "    git rev-parse --verify HEAD",
    "Report the first as candidate_commit and the second as checkout_commit. Do not copy an expected SHA from this prompt; none is supplied. If either command fails, set ran:false and check_exit:-1.",
    "",
    "Run this CHECK command VERBATIM by spawning bash with the command as a single argument:",
    `    ${bashCheckCommand(opts.check)}`,
    ...(opts.parityCheck !== undefined
      ? [
          "",
          "Then run this PARITY command VERBATIM in the same worktree, by spawning bash with the command as a single argument:",
          `    ${bashCheckCommand(opts.parityCheck)}`,
          "The PARITY command replays the blocking CI steps and can take several minutes, which can exceed a single shell call's timeout. Run it in the background writing to a log file and poll until the process exits (or run it at the longest timeout your shell tool allows and then keep waiting on the process); never report parity_exit before the PARITY command has exited.",
        ]
      : []),
    "",
    "Set ran:true only if both identity commands and the CHECK ran to completion. Report the true CHECK exit code.",
    ...(opts.parityCheck !== undefined
      ? [
          "Report the PARITY exit code as parity_exit; the candidate fails when parity_exit is nonzero even if check_exit is 0.",
        ]
      : []),
    opts.parityCheck !== undefined
      ? "If the CHECK or PARITY fails, populate failing_segment and output_tail with bounded failure evidence from the command that failed — from the PARITY run when parity_exit is nonzero."
      : "If the CHECK fails, populate failing_segment and output_tail with bounded failure evidence.",
    "",
    renderJsonContract({
      example: checkVerifyExample(opts.parityCheck !== undefined),
      name: "CHECK_VERIFY",
    }),
  ].join("\n");
}

function unavailable(
  failOutput: string,
  handoffId: string | null = null,
  branch: string | null = null,
): VerifyCheckOutcome {
  return {
    status: "unavailable",
    result: null,
    verifier_handoff_id: handoffId,
    verifier_branch: branch,
    fail_output: failOutput,
  };
}

function failureOutput(result: CheckVerifyResult): string {
  const details = [result.failing_segment, result.output_tail, result.notes]
    .filter(Boolean)
    .join("\n");
  return (
    details ||
    `Independent CHECK verifier measured check_exit=${String(result.check_exit)}, ran=${String(result.ran)}`
  );
}

function verifierDispatchBindingFailure(
  result: FanoutTaskResult,
  verifier: CandidateRef,
  expectedSha: string,
): VerifyCheckOutcome | null {
  if (result.root_handoff_id !== verifier.handoffId) {
    return unavailable(
      `Independent CHECK verifier response identity was unsupported: expected ${verifier.handoffId}, received ${String(result.root_handoff_id)}.`,
      verifier.handoffId,
      verifier.branch,
    );
  }
  if (result.branch_base !== expectedSha) {
    return unavailable(
      `Independent CHECK verifier persisted root branch_base mismatch: expected ${expectedSha}, received ${String(result.branch_base)}.`,
      verifier.handoffId,
      verifier.branch,
    );
  }
  return null;
}

async function dispatchVerifier(
  ctx: WorkflowCtx,
  opts: {
    prompt: string;
    expectedSha: string;
    verifierAgent: string;
    timeoutMs: number;
    projectId: string;
  },
): Promise<Awaited<ReturnType<typeof runFanout>> | null> {
  try {
    return await runFanout(ctx, {
      tasks: [
        {
          message: opts.prompt,
          label: "verify-check",
          task_name: "verify-check",
          initial_agent: opts.verifierAgent,
          task_class: "STANDARD",
          task_type: "review_adversarial",
          use_worktree: true,
          branch_base: opts.expectedSha,
          isolated_install: true,
          max_hops: 1,
          tool_free: true,
          timeout_ms: opts.timeoutMs,
        },
      ],
      defaults: { project_id: opts.projectId, timeout_ms: opts.timeoutMs },
    });
  } catch {
    return null;
  }
}

function interpretVerifierResponse(
  responseText: string,
  verifier: CandidateRef,
  expectedSha: string,
  parityCheck?: string,
): VerifyCheckOutcome {
  const parsed = parseStructured(
    responseText,
    CheckVerifySchema as unknown as SafeParseSchema<CheckVerifyResult>,
  );
  if (!parsed.ok) {
    const issues = parsed.issues ? ` (${parsed.issues.join("; ")})` : "";
    return unavailable(
      `Independent CHECK verifier response was untrusted: ${parsed.error}${issues}`,
      verifier.handoffId,
      verifier.branch,
    );
  }
  const measured = parsed.value;
  if (!measured.ran || measured.check_exit !== 0) {
    return {
      status: "failed",
      result: measured,
      verifier_handoff_id: verifier.handoffId,
      verifier_branch: verifier.branch,
      fail_output: failureOutput(measured),
    };
  }
  if (measured.candidate_commit !== measured.checkout_commit) {
    return {
      status: "failed",
      result: measured,
      verifier_handoff_id: verifier.handoffId,
      verifier_branch: verifier.branch,
      fail_output: `Independent CHECK verifier target mismatch: candidate_commit=${String(measured.candidate_commit)}, checkout_commit=${String(measured.checkout_commit)}.`,
    };
  }
  if (measured.candidate_commit !== expectedSha) {
    return {
      status: "failed",
      result: measured,
      verifier_handoff_id: verifier.handoffId,
      verifier_branch: verifier.branch,
      fail_output: `Independent CHECK verifier host identity mismatch: candidate_commit=${String(measured.candidate_commit)} does not match host-observed SHA ${expectedSha}.`,
    };
  }
  if (measured.checkout_commit !== expectedSha) {
    return {
      status: "failed",
      result: measured,
      verifier_handoff_id: verifier.handoffId,
      verifier_branch: verifier.branch,
      fail_output: `Independent CHECK verifier host identity mismatch: checkout_commit=${String(measured.checkout_commit)} does not match host-observed SHA ${expectedSha}.`,
    };
  }
  if (parityCheck !== undefined && measured.parity_exit !== 0) {
    const details = [measured.failing_segment, measured.output_tail, measured.notes]
      .filter(Boolean)
      .join("\n");
    return {
      status: "failed",
      result: measured,
      verifier_handoff_id: verifier.handoffId,
      verifier_branch: verifier.branch,
      fail_output: [
        `Independent CHECK verifier measured parity_exit=${String(measured.parity_exit ?? "missing")}; the parity check must exit 0.`,
        details,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  return {
    status: "passed",
    result: measured,
    verifier_handoff_id: verifier.handoffId,
    verifier_branch: verifier.branch,
    fail_output: "",
  };
}

export async function runVerifyCheck(
  ctx: WorkflowCtx,
  opts: {
    check: string;
    candidateBranch: string;
    candidateHandoffId: string;
    verifierAgent: string;
    timeoutMs: number;
    projectId?: string;
    parityCheck?: string;
  },
): Promise<VerifyCheckOutcome> {
  const projectId = opts.projectId ?? ctx.project;
  const preInspect = await inspectBoundWorktree(ctx, {
    handoffId: opts.candidateHandoffId,
    branchName: opts.candidateBranch,
    projectId,
  });
  if (!preInspect.ok) {
    return unavailable(worktreeBindingFailure("Independent CHECK candidate pre", preInspect));
  }
  const expectedSha = preInspect.headSha;

  const prompt = buildVerifyPrompt(opts);
  const stage = await dispatchVerifier(ctx, {
    prompt,
    expectedSha,
    verifierAgent: opts.verifierAgent,
    timeoutMs: opts.timeoutMs,
    projectId,
  });
  const result = stage?.results[0] ?? null;
  const verifier = resolveAuthoritativeCandidate(result);
  if (result?.status !== "completed") {
    return unavailable(
      "Independent CHECK verifier dispatch was unavailable or non-terminal.",
      verifier.ok ? verifier.candidate.handoffId : (result?.handoff_id ?? null),
      verifier.ok ? verifier.candidate.branch : (result?.branch_name ?? null),
    );
  }
  if (!verifier.ok) {
    return unavailable(
      `Independent CHECK verifier latest identity was unsupported: ${verifier.reason}.`,
    );
  }
  const dispatchBindingFailure = verifierDispatchBindingFailure(
    result,
    verifier.candidate,
    expectedSha,
  );
  if (dispatchBindingFailure) return dispatchBindingFailure;
  const verifierInspect = await inspectBoundWorktree(ctx, {
    handoffId: verifier.candidate.handoffId,
    branchName: verifier.candidate.branch,
    projectId,
    headSha: expectedSha,
  });
  if (!verifierInspect.ok) {
    return unavailable(
      worktreeBindingFailure("Independent CHECK verifier host", verifierInspect),
      verifier.candidate.handoffId,
      verifier.candidate.branch,
    );
  }
  const responseText = result.response_text;
  if (!responseText?.trim()) {
    return unavailable(
      "Independent CHECK verifier returned no response.",
      verifier.candidate.handoffId,
      verifier.candidate.branch,
    );
  }

  const outcome = interpretVerifierResponse(
    responseText,
    verifier.candidate,
    expectedSha,
    opts.parityCheck,
  );
  if (outcome.status !== "passed") return outcome;

  const postInspect = await inspectBoundWorktree(ctx, {
    handoffId: opts.candidateHandoffId,
    branchName: opts.candidateBranch,
    projectId,
    headSha: expectedSha,
  });
  if (!postInspect.ok) {
    return unavailable(
      worktreeBindingFailure("Independent CHECK candidate post", postInspect),
      verifier.candidate.handoffId,
      verifier.candidate.branch,
    );
  }

  return outcome;
}
