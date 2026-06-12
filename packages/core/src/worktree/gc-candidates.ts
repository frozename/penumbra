import { statSync } from "node:fs";
import type { OrphanWorktreeHandle, WorktreeHandle } from "./manager.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "rejected", "expired"]);

export type WorktreeGcCandidateReason =
  | "terminal_tracked"
  | "terminal_orphan"
  | "missing_handoff_orphan";

export interface WorktreeGcCandidate {
  handoff_id: string;
  branch: string;
  status: string;
  resolved_at: string;
  path: string;
  age_ms: number;
  reason: WorktreeGcCandidateReason;
}

interface HandoffLookup {
  get(handoffId: string): { status: string; resolved_at: string | null } | null;
}

export interface SelectWorktreeGcCandidatesOpts {
  trackedHandles: WorktreeHandle[];
  orphanHandles: OrphanWorktreeHandle[];
  handoffReader: HandoffLookup;
  gracePeriodMs: number;
  nowMs: number;
  getFileMtime?: (targetPath: string) => number;
}

export function selectWorktreeGcCandidates(
  opts: SelectWorktreeGcCandidatesOpts,
): WorktreeGcCandidate[] {
  const candidates: WorktreeGcCandidate[] = [];

  for (const handle of opts.trackedHandles) {
    const handoff = opts.handoffReader.get(handle.handoffId);
    if (!handoff) continue;
    if (!TERMINAL_STATUSES.has(handoff.status)) continue;

    const resolvedAt = handoff.resolved_at ? new Date(handoff.resolved_at).getTime() : null;
    if (resolvedAt === null || opts.nowMs - resolvedAt < opts.gracePeriodMs) continue;

    candidates.push({
      handoff_id: handle.handoffId,
      branch: handle.branchName,
      status: handoff.status,
      resolved_at: handoff.resolved_at!,
      path: handle.path,
      age_ms: opts.nowMs - resolvedAt,
      reason: "terminal_tracked",
    });
  }

  for (const orphan of opts.orphanHandles) {
    const handoff = opts.handoffReader.get(orphan.handoffId);
    if (handoff) {
      if (!TERMINAL_STATUSES.has(handoff.status)) continue;

      const resolvedAt = handoff.resolved_at ? new Date(handoff.resolved_at).getTime() : null;
      if (resolvedAt === null || opts.nowMs - resolvedAt < opts.gracePeriodMs) continue;

      candidates.push({
        handoff_id: orphan.handoffId,
        branch: `agent/${orphan.handoffId}`,
        status: handoff.status,
        resolved_at: handoff.resolved_at!,
        path: orphan.path,
        age_ms: opts.nowMs - resolvedAt,
        reason: "terminal_orphan",
      });
      continue;
    }

    let mtimeMs: number;
    try {
      mtimeMs = (opts.getFileMtime ?? fileMtimeMs)(orphan.path);
    } catch {
      continue;
    }
    if (opts.nowMs - mtimeMs < opts.gracePeriodMs) continue;

    candidates.push({
      handoff_id: orphan.handoffId,
      branch: `agent/${orphan.handoffId}`,
      status: "missing",
      resolved_at: new Date(mtimeMs).toISOString(),
      path: orphan.path,
      age_ms: opts.nowMs - mtimeMs,
      reason: "missing_handoff_orphan",
    });
  }

  candidates.sort((a, b) => a.age_ms - b.age_ms);
  return candidates;
}

function fileMtimeMs(targetPath: string): number {
  return statSync(targetPath).mtimeMs;
}
