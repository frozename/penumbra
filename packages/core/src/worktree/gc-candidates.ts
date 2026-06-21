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

type TerminalHandoff = { status: string; resolved_at: string };

function terminalHandoffPastGrace(
  handoff: { status: string; resolved_at: string | null } | null,
  nowMs: number,
  gracePeriodMs: number,
): TerminalHandoff | null {
  if (!handoff || !TERMINAL_STATUSES.has(handoff.status)) return null;
  const resolvedAtStr = handoff.resolved_at;
  if (resolvedAtStr === null) return null;
  const resolvedAtMs = new Date(resolvedAtStr).getTime();
  if (nowMs - resolvedAtMs < gracePeriodMs) return null;
  return { status: handoff.status, resolved_at: resolvedAtStr };
}

function pushTrackedCandidate(
  candidates: WorktreeGcCandidate[],
  handle: WorktreeHandle,
  opts: SelectWorktreeGcCandidatesOpts,
): void {
  const handoff = opts.handoffReader.get(handle.handoffId);
  const terminal = terminalHandoffPastGrace(handoff, opts.nowMs, opts.gracePeriodMs);
  if (!terminal) return;
  candidates.push({
    handoff_id: handle.handoffId,
    branch: handle.branchName,
    status: terminal.status,
    resolved_at: terminal.resolved_at,
    path: handle.path,
    age_ms: opts.nowMs - new Date(terminal.resolved_at).getTime(),
    reason: "terminal_tracked",
  });
}

function pushOrphanCandidate(
  candidates: WorktreeGcCandidate[],
  orphan: OrphanWorktreeHandle,
  opts: SelectWorktreeGcCandidatesOpts,
): void {
  const handoff = opts.handoffReader.get(orphan.handoffId);
  if (handoff) {
    const terminal = terminalHandoffPastGrace(handoff, opts.nowMs, opts.gracePeriodMs);
    if (!terminal) return;
    candidates.push({
      handoff_id: orphan.handoffId,
      branch: `agent/${orphan.handoffId}`,
      status: terminal.status,
      resolved_at: terminal.resolved_at,
      path: orphan.path,
      age_ms: opts.nowMs - new Date(terminal.resolved_at).getTime(),
      reason: "terminal_orphan",
    });
    return;
  }

  let mtimeMs: number;
  try {
    mtimeMs = (opts.getFileMtime ?? fileMtimeMs)(orphan.path);
  } catch {
    return;
  }
  if (opts.nowMs - mtimeMs < opts.gracePeriodMs) return;

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

export function selectWorktreeGcCandidates(
  opts: SelectWorktreeGcCandidatesOpts,
): WorktreeGcCandidate[] {
  const candidates: WorktreeGcCandidate[] = [];
  for (const handle of opts.trackedHandles) pushTrackedCandidate(candidates, handle, opts);
  for (const orphan of opts.orphanHandles) pushOrphanCandidate(candidates, orphan, opts);
  candidates.sort((a, b) => a.age_ms - b.age_ms);
  return candidates;
}

function fileMtimeMs(targetPath: string): number {
  return statSync(targetPath).mtimeMs;
}
