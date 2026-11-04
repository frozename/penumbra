import type { FixturePublic, HoldoutLock, HoldoutLockEntry, RootRef } from "./fixture.js";

import { digestOf } from "./canonical.js";
import { HoldoutLockSchema } from "./fixture.js";

export class HoldoutLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoldoutLockError";
  }
}

export class HoldoutReservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoldoutReservationError";
  }
}

export class PublicFixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicFixError";
  }
}

export function computeLockDigest(entries: readonly HoldoutLockEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    if (a.family_id !== b.family_id) return a.family_id < b.family_id ? -1 : 1;
    if (a.variant_id !== b.variant_id) return a.variant_id < b.variant_id ? -1 : 1;
    return 0;
  });
  return digestOf(sorted);
}

export function verifyHoldoutLock(lock: unknown): HoldoutLock {
  const result = HoldoutLockSchema.safeParse(lock);
  if (!result.success) {
    throw new HoldoutLockError(`invalid holdout lock: ${result.error.message}`);
  }
  const parsed = result.data;
  if (computeLockDigest(parsed.entries) !== parsed.digest) {
    throw new HoldoutLockError("holdout lock digest does not match its entries");
  }
  return parsed;
}

function rootEquals(a: RootRef, b: RootRef): boolean {
  if (a.kind === "issue" && b.kind === "issue") return a.number === b.number;
  if (a.kind !== "issue" && b.kind !== "issue") return a.kind === b.kind && a.id === b.id;
  return false;
}

export function assertHoldoutReservation(
  lock: HoldoutLock,
  publicFixtures: readonly FixturePublic[],
): { type_novel: boolean } {
  for (const entry of lock.entries) {
    if (entry.synthetic) continue;
    for (const fixture of publicFixtures) {
      const collides =
        rootEquals(fixture.root, entry.root) ||
        (fixture.reconstructs !== null && rootEquals(fixture.reconstructs, entry.root));
      if (collides) {
        throw new HoldoutReservationError(
          `public fixture ${fixture.family_id}/${fixture.variant_id} collides with reserved lock root of ${entry.family_id}`,
        );
      }
    }
  }
  const publicFailureTypes = new Set(publicFixtures.map((fixture) => fixture.failure_type));
  const typeNovel = lock.entries.some(
    (entry) =>
      !entry.synthetic &&
      entry.failure_type !== null &&
      !publicFailureTypes.has(entry.failure_type),
  );
  return { type_novel: typeNovel };
}

export type IssueClosureEvidence = {
  state: "OPEN" | "CLOSED";
  closing_commits: { sha: string; is_ancestor_of_head: boolean }[];
};

export type PublicFixEvidence = Record<
  string,
  {
    issue_closure: IssueClosureEvidence | null;
    patch_id_hits: number;
    added_line_hits: number;
    head_sha: string;
  }
>;

function assertHeadAligned(key: string, head_sha: string, expected: string | null): string {
  if (expected !== null && head_sha !== expected) {
    throw new PublicFixError(
      `public-fix evidence for ${key} was collected at head ${head_sha}, not ${expected}`,
    );
  }
  return head_sha;
}

function assertIssueNotFixed(key: string, closure: IssueClosureEvidence | null): void {
  if (closure === null) {
    throw new PublicFixError(`issue closure state unknown for ${key}; failing closed`);
  }
  if (closure.state !== "CLOSED") return;
  if (closure.closing_commits.length === 0) {
    throw new PublicFixError(`issue for ${key} is CLOSED without closing commits`);
  }
  if (closure.closing_commits.some((commit) => commit.is_ancestor_of_head)) {
    throw new PublicFixError(`issue for ${key} was closed by a commit reachable from head`);
  }
}

export function assertNoPublicFix(lock: HoldoutLock, evidence: PublicFixEvidence): void {
  let checkedHeadSha: string | null = null;
  for (const entry of lock.entries) {
    if (entry.synthetic) continue;
    const key = `${entry.family_id}/${entry.variant_id}`;
    const item = evidence[key];
    if (item === undefined) {
      throw new PublicFixError(`missing public-fix evidence for ${key}`);
    }
    checkedHeadSha = assertHeadAligned(key, item.head_sha, checkedHeadSha);
    if (item.patch_id_hits + item.added_line_hits > 0) {
      throw new PublicFixError(`public-fix evidence for ${key} reports content hits`);
    }
    if (entry.root.kind === "issue") {
      assertIssueNotFixed(key, item.issue_closure);
    }
  }
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export function unsealHoldout(
  lock: HoldoutLock,
  plan: { sha256: string; max_unseals: number },
): { lock_digest: string; analysis_plan_sha256: string; max_unseals: number } {
  const verified = verifyHoldoutLock(lock);
  if (!SHA256_HEX_RE.test(plan.sha256)) {
    throw new HoldoutLockError("analysis plan sha256 must be 64 lowercase hex characters");
  }
  if (!Number.isInteger(plan.max_unseals) || plan.max_unseals < 1) {
    throw new HoldoutLockError("max_unseals must be an integer >= 1");
  }
  return {
    lock_digest: verified.digest,
    analysis_plan_sha256: plan.sha256,
    max_unseals: plan.max_unseals,
  };
}
