import { CommitIntegrityEvidenceSchema } from "@penumbra/api-contract";

import type { HandoffRow } from "../schemas/handoff.js";

import { FULL_GIT_SHA_RE } from "../schemas/agent-performance.js";

// Bounds a dispatch_events read to the current attempt: only rows logged after
// the latest 'claim' event. A no-op when the handoff was never re-claimed.
export const CURRENT_ATTEMPT_EVENT_BOUND_SQL =
  "id > COALESCE((SELECT MAX(id) FROM dispatch_events WHERE handoff_id = ? AND kind = 'claim'), 0)";

export function currentAttempt(handoff: HandoffRow): number | null {
  const attempt = handoff.dispatch_attempts;
  return typeof attempt === "number" && Number.isInteger(attempt) && attempt >= 0 ? attempt : null;
}

export function isStaleAttempt(
  input: { dispatch_attempt?: number },
  attempt: number | null,
): boolean {
  return (
    attempt !== null && input.dispatch_attempt !== undefined && input.dispatch_attempt < attempt
  );
}

// The head the worker finished on: the autocommit SHA wins when the worker
// committed itself, since a post-autocommit re-probe may have raced or failed.
export function resolveWorkerHeadSha(meta: Record<string, unknown> | null): string | null {
  if (meta?.autocommitted === true) {
    const sha = meta.autocommit_sha;
    return typeof sha === "string" && FULL_GIT_SHA_RE.test(sha) ? sha : null;
  }
  const parsed = CommitIntegrityEvidenceSchema.safeParse(meta?.commit_integrity);
  return parsed.success ? parsed.data.head_sha : null;
}
