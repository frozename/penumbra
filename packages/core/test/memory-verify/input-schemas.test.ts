import { expect, test } from "bun:test";
import { z } from "zod";

import { BasisSchema } from "@src/memory-verify/basis.js";
import {
  MemoryVerifyAuthorizeInputShape,
  MemoryVerifyClaimInputShape,
} from "@src/memory-verify/schemas.js";

const Claim = z.object(MemoryVerifyClaimInputShape);
const Authorize = z.object(MemoryVerifyAuthorizeInputShape);

type SchemaResult = { success: true } | { success: false; error: z.ZodError };

function issuePaths(r: SchemaResult): string[] {
  if (r.success) return [];
  // Empty strings trip both min(1) and the charset regex on the same path; dedup so the
  // assertion stays "exactly the mutated field".
  return [...new Set(r.error.issues.map((i) => i.path.join(".")))];
}

const basis = { kind: "manual_override", reason: "r", authorized_by: "op" } as const;
const claimBase = { memory_id: "m1", basis };
const authBase = { handoff_id: "h1", verdict: "passed", basis };

function parseClaim(input: unknown): SchemaResult {
  return Claim.safeParse(input);
}

function parseAuthorize(input: unknown): SchemaResult {
  return Authorize.safeParse(input);
}

test("claim baseline parses with claimed_by, by, reason and session_id omitted", () => {
  const r = parseClaim(claimBase);
  expect(r.success).toBe(true);
  expect(issuePaths(r)).toEqual([]);
});

test("claim memory_id rejects the empty string", () => {
  const r = parseClaim({ ...claimBase, memory_id: "" });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["memory_id"]);
});

test("claim requires basis", () => {
  const { basis: _omitted, ...withoutBasis } = claimBase;
  const r = parseClaim(withoutBasis);
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["basis"]);
});

test("claimed_by accepts the full allowed charset", () => {
  const r = parseClaim({ ...claimBase, claimed_by: "Ag.e_n:t-1@wt" });
  expect(r.success).toBe(true);
});

test("claimed_by rejects a space", () => {
  const r = parseClaim({ ...claimBase, claimed_by: "agent name" });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["claimed_by"]);
});

test("claimed_by rejects a slash", () => {
  const r = parseClaim({ ...claimBase, claimed_by: "a/b" });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["claimed_by"]);
});

test("claimed_by accepts 120 characters", () => {
  const r = parseClaim({ ...claimBase, claimed_by: "a".repeat(120) });
  expect(r.success).toBe(true);
});

test("claimed_by rejects 121 characters", () => {
  const r = parseClaim({ ...claimBase, claimed_by: "a".repeat(121) });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["claimed_by"]);
});

test("claimed_by rejects the empty string", () => {
  const r = parseClaim({ ...claimBase, claimed_by: "" });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["claimed_by"]);
});

test("deprecated by field rejects a space", () => {
  const r = parseClaim({ ...claimBase, by: "a b" });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["by"]);
});

test("deprecated by field accepts '@' and ':'", () => {
  const r = parseClaim({ ...claimBase, by: "x@y:z" });
  expect(r.success).toBe(true);
});

test("reason accepts 500 characters", () => {
  const r = parseClaim({ ...claimBase, reason: "r".repeat(500) });
  expect(r.success).toBe(true);
});

test("reason rejects 501 characters", () => {
  const r = parseClaim({ ...claimBase, reason: "r".repeat(501) });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["reason"]);
});

test("reason rejects the empty string", () => {
  const r = parseClaim({ ...claimBase, reason: "" });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["reason"]);
});

test("session_id accepts dots, underscore and dash", () => {
  const r = parseClaim({ ...claimBase, session_id: "sess-1.a_b" });
  expect(r.success).toBe(true);
});

test("session_id rejects ':' unlike claimed_by", () => {
  const r = parseClaim({ ...claimBase, session_id: "s:1" });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["session_id"]);
});

test("session_id rejects '@' unlike claimed_by", () => {
  const r = parseClaim({ ...claimBase, session_id: "s@1" });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["session_id"]);
});

test("session_id accepts 120 characters", () => {
  const r = parseClaim({ ...claimBase, session_id: "s".repeat(120) });
  expect(r.success).toBe(true);
});

test("session_id rejects 121 characters", () => {
  const r = parseClaim({ ...claimBase, session_id: "s".repeat(121) });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["session_id"]);
});

test("authorize verdict accepts each enum member", () => {
  for (const verdict of ["passed", "failed", "skipped", "review_debt"]) {
    const r = parseAuthorize({ ...authBase, verdict });
    expect(r.success).toBe(true);
  }
});

test("authorize verdict rejects a value outside the enum", () => {
  const r = parseAuthorize({ ...authBase, verdict: "pending" });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["verdict"]);
});

test("authorize handoff_id rejects the empty string", () => {
  const r = parseAuthorize({ ...authBase, handoff_id: "" });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["handoff_id"]);
});

test("authorize authorized_by_handoff may be omitted", () => {
  const r = parseAuthorize(authBase);
  expect(r.success).toBe(true);
});

test("authorize authorized_by_handoff accepts null", () => {
  const r = parseAuthorize({ ...authBase, authorized_by_handoff: null });
  expect(r.success).toBe(true);
});

test("authorize authorized_by_handoff accepts a non-empty id", () => {
  const r = parseAuthorize({ ...authBase, authorized_by_handoff: "h2" });
  expect(r.success).toBe(true);
});

test("authorize authorized_by_handoff rejects the empty string", () => {
  const r = parseAuthorize({ ...authBase, authorized_by_handoff: "" });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["authorized_by_handoff"]);
});

test("basis rejects an unknown kind", () => {
  const r = BasisSchema.safeParse({ kind: "lgtm" });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["kind"]);
});

test("dispatch_land merge_commit accepts 7 lowercase hex chars", () => {
  const r = BasisSchema.safeParse({
    kind: "dispatch_land",
    merge_commit: "abcdef0",
    reviewer_handoff: "r1",
  });
  expect(r.success).toBe(true);
});

test("dispatch_land merge_commit accepts 40 lowercase hex chars", () => {
  const r = BasisSchema.safeParse({
    kind: "dispatch_land",
    merge_commit: "a".repeat(40),
    reviewer_handoff: "r1",
  });
  expect(r.success).toBe(true);
});

test("dispatch_land merge_commit rejects 6 characters", () => {
  const r = BasisSchema.safeParse({
    kind: "dispatch_land",
    merge_commit: "abcdef",
    reviewer_handoff: "r1",
  });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["merge_commit"]);
});

test("dispatch_land merge_commit rejects 41 characters", () => {
  const r = BasisSchema.safeParse({
    kind: "dispatch_land",
    merge_commit: "a".repeat(41),
    reviewer_handoff: "r1",
  });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["merge_commit"]);
});

test("dispatch_land merge_commit rejects uppercase at a valid length", () => {
  const r = BasisSchema.safeParse({
    kind: "dispatch_land",
    merge_commit: "ABCDEF0",
    reviewer_handoff: "r1",
  });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["merge_commit"]);
});

test("dispatch_land merge_commit rejects non-hex lowercase at a valid length", () => {
  const r = BasisSchema.safeParse({
    kind: "dispatch_land",
    merge_commit: "ghijklm",
    reviewer_handoff: "r1",
  });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["merge_commit"]);
});

test("lane_close rejects an empty lane_id", () => {
  const r = BasisSchema.safeParse({ kind: "lane_close", lane_id: "", reviewer_handoff: "r1" });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["lane_id"]);
});

test("lane_close rejects an empty reviewer_handoff", () => {
  const r = BasisSchema.safeParse({ kind: "lane_close", lane_id: "l1", reviewer_handoff: "" });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["reviewer_handoff"]);
});

test("adversarial_review rejects an empty synthesis_path", () => {
  const r = BasisSchema.safeParse({
    kind: "adversarial_review",
    synthesis_path: "",
    synthesizer_handoff: "s1",
  });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["synthesis_path"]);
});

test("adversarial_review rejects an empty synthesizer_handoff", () => {
  const r = BasisSchema.safeParse({
    kind: "adversarial_review",
    synthesis_path: "p",
    synthesizer_handoff: "",
  });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["synthesizer_handoff"]);
});

test("manual_override rejects an empty reason", () => {
  const r = BasisSchema.safeParse({
    kind: "manual_override",
    reason: "",
    authorized_by: "op",
  });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["reason"]);
});

test("manual_override rejects an empty authorized_by", () => {
  const r = BasisSchema.safeParse({
    kind: "manual_override",
    reason: "r",
    authorized_by: "",
  });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toEqual(["authorized_by"]);
});

test("cross-kind fields do not satisfy the manual_override variant", () => {
  const r = BasisSchema.safeParse({
    kind: "manual_override",
    lane_id: "l1",
    reviewer_handoff: "r1",
  });
  expect(r.success).toBe(false);
  expect(issuePaths(r)).toContain("reason");
  expect(issuePaths(r)).toContain("authorized_by");
});
