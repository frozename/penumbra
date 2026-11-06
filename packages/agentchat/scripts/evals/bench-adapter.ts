import { type ReceiptClaimBody, ReceiptClaimSchema } from "@penumbra/core/evals/manifest";
import { z } from "zod";

const RoundRecordLikeSchema = z.object({
  round: z.number(),
  dispatch_ok: z.boolean(),
  passed: z.boolean(),
  check_passed: z.boolean(),
  verified: z.boolean(),
  autocommitted: z.boolean().optional(),
  autocommit_sha: z.string().optional(),
});

type RoundRecordLike = z.infer<typeof RoundRecordLikeSchema>;

export interface AdaptedCommits {
  final_commit_attribution: string;
  attribution_basis: string;
  autocommit_flag: boolean | null;
}

export interface AdaptedRecord {
  attempt_n: number;
  dispatch_ok: boolean;
  check_passed: boolean;
  passed: boolean;
  commits: AdaptedCommits;
  assistance: { kind: string; attempt_n: number; ref: string | null }[];
  receipts: ReceiptClaimBody[];
}

function selfReportClaim(checkPassed: boolean): ReceiptClaimBody {
  return ReceiptClaimSchema.parse({
    kind: "self_report",
    sha: null,
    producer: "fix_until_green_check",
    claimed_verdict: checkPassed ? "pass" : "fail",
    fail_reason: null,
    assertion_set_digest: null,
    grader_build: null,
    per_check: null,
    control_verdict: null,
    receipt_digest: null,
  });
}

function commitsFor(record: RoundRecordLike): AdaptedCommits {
  if (record.autocommitted === true) {
    return {
      final_commit_attribution: "recovery",
      attribution_basis: "dispatch_end_autocommitted",
      autocommit_flag: true,
    };
  }
  return {
    final_commit_attribution: "unknown",
    attribution_basis: "none",
    autocommit_flag: null,
  };
}

function assistanceFor(record: RoundRecordLike): AdaptedRecord["assistance"] {
  if (record.autocommitted !== true) {
    return [];
  }
  return [
    { kind: "recovery_autocommit", attempt_n: record.round, ref: record.autocommit_sha ?? null },
  ];
}

export function adaptRoundRecord(raw: unknown): AdaptedRecord {
  const record = RoundRecordLikeSchema.parse(raw);
  return {
    attempt_n: record.round,
    dispatch_ok: record.dispatch_ok,
    check_passed: record.check_passed,
    passed: record.passed,
    commits: commitsFor(record),
    assistance: assistanceFor(record),
    receipts: [selfReportClaim(record.check_passed)],
  };
}

type BenchVerdict = "PASS" | "PARTIAL" | "FAIL";

function claimedVerdict(verdict: string): ReceiptClaimBody["claimed_verdict"] {
  if (verdict === "PASS") {
    return "pass";
  }
  if (verdict === "FAIL") {
    return "fail";
  }
  return "unknown";
}

function benchClaim(
  kind: "schema_check" | "llm_judge",
  producer: string,
  verdict: string,
  sha: string | null,
): ReceiptClaimBody {
  return ReceiptClaimSchema.parse({
    kind,
    sha,
    producer,
    claimed_verdict: claimedVerdict(verdict),
    fail_reason: null,
    assertion_set_digest: null,
    grader_build: null,
    per_check: null,
    control_verdict: null,
    receipt_digest: null,
  });
}

export function schemaCheckClaim(
  verdict: { verdict: BenchVerdict; detail: string },
  sha: string | null,
): ReceiptClaimBody {
  return benchClaim("schema_check", "bench_schema", verdict.verdict, sha);
}

export function judgeClaim(
  verdict: { verdict: string; model?: string },
  sha: string | null,
): ReceiptClaimBody {
  return benchClaim("llm_judge", "bench_judge", verdict.verdict, sha);
}
