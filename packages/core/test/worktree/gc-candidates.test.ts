import { expect, test } from "bun:test";

import type { HandoffStatus } from "@src/schemas/handoff.js";
import {
  selectWorktreeGcCandidates,
  type SelectWorktreeGcCandidatesOpts,
  type WorktreeGcCandidate,
} from "@src/worktree/gc-candidates.js";
import type { OrphanWorktreeHandle, WorktreeHandle } from "@src/worktree/manager.js";

// #342: pin which dispatch worktrees selectWorktreeGcCandidates hands to the
// daemon sweeper and `penumbra worktree gc` for deletion. Every input is
// injected: a fixed clock, a static handoff reader and a fake getFileMtime.
const NOW_MS = Date.UTC(2026, 9, 28, 12);
const GRACE_MS = 3_600_000;

const TERMINAL_STATUSES: HandoffStatus[] = ["completed", "failed", "rejected", "expired"];
const LIVE_STATUSES: HandoffStatus[] = ["pending", "approved", "redirected", "dispatched"];

interface HandoffRow {
  handoff_id?: string;
  branch_name?: string | null;
  status: string;
  resolved_at: string | null;
}

function agoIso(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

function trackedHandle(handoffId: string): WorktreeHandle {
  return {
    handoffId,
    path: `/wt/${handoffId}`,
    branchName: `feat/gc-pin_${handoffId}`,
    storageRoot: "/wt",
    createdAt: "2026-10-01T00:00:00.000Z",
    status: "created",
    worktreeMode: "symlink_mirror",
  };
}

function orphanHandle(handoffId: string): OrphanWorktreeHandle {
  return { handoffId, path: `/wt/${handoffId}` };
}

function readerOf(
  rows: Record<string, HandoffRow>,
): SelectWorktreeGcCandidatesOpts["handoffReader"] {
  return {
    get: (handoffId: string): HandoffRow | null => rows[handoffId] ?? null,
  };
}

// A path missing from the map makes the fake throw, like statSync on a vanished dir.
function mtimeFrom(mtimes: Record<string, number>): (targetPath: string) => number {
  return (targetPath: string): number => {
    const mtimeMs = mtimes[targetPath];
    if (mtimeMs === undefined) {
      throw new Error(`no mtime for ${targetPath}`);
    }
    return mtimeMs;
  };
}

function select(overrides: Partial<SelectWorktreeGcCandidatesOpts>): WorktreeGcCandidate[] {
  return selectWorktreeGcCandidates({
    trackedHandles: [],
    orphanHandles: [],
    handoffReader: readerOf({}),
    gracePeriodMs: GRACE_MS,
    nowMs: NOW_MS,
    getFileMtime: mtimeFrom({}),
    ...overrides,
  });
}

test.each(TERMINAL_STATUSES)(
  "a tracked %s handoff resolved exactly gracePeriodMs ago is a terminal_tracked candidate",
  (status) => {
    const resolvedAt = agoIso(GRACE_MS);
    const got = select({
      trackedHandles: [trackedHandle("h-edge")],
      handoffReader: readerOf({
        "h-edge": { status, resolved_at: resolvedAt, branch_name: "fix/row-branch_h-edge" },
      }),
    });
    expect(got).toEqual([
      {
        handoff_id: "h-edge",
        branch: "feat/gc-pin_h-edge",
        status,
        resolved_at: resolvedAt,
        path: "/wt/h-edge",
        age_ms: GRACE_MS,
        reason: "terminal_tracked",
      },
    ]);
  },
);

test.each(TERMINAL_STATUSES)(
  "a tracked %s handoff resolved 1 ms inside the grace period is not a candidate",
  (status) => {
    const got = select({
      trackedHandles: [trackedHandle("h-fresh")],
      handoffReader: readerOf({ "h-fresh": { status, resolved_at: agoIso(GRACE_MS - 1) } }),
    });
    expect(got).toEqual([]);
  },
);

test.each(LIVE_STATUSES)(
  "a tracked %s handoff is never a candidate, however old its resolved_at",
  (status) => {
    const got = select({
      trackedHandles: [trackedHandle("h-live")],
      handoffReader: readerOf({ "h-live": { status, resolved_at: agoIso(100 * GRACE_MS) } }),
    });
    expect(got).toEqual([]);
  },
);

test("a tracked handle with resolved_at null or with no handoff row is not a candidate", () => {
  const statted: string[] = [];
  const got = select({
    trackedHandles: [trackedHandle("h-null"), trackedHandle("h-gone")],
    handoffReader: readerOf({ "h-null": { status: "completed", resolved_at: null } }),
    getFileMtime: (targetPath: string): number => {
      statted.push(targetPath);
      return NOW_MS - 100 * GRACE_MS;
    },
  });
  expect(got).toEqual([]);
  expect(statted).toEqual([]);
});

test("an orphan with a terminal handoff past the grace period is a terminal_orphan candidate", () => {
  const got = select({
    orphanHandles: [
      orphanHandle("h-named"),
      orphanHandle("h-null-branch"),
      orphanHandle("h-no-branch"),
      orphanHandle("h-recent"),
    ],
    handoffReader: readerOf({
      "h-named": {
        status: "failed",
        resolved_at: agoIso(2 * GRACE_MS),
        branch_name: "fix/orphan_h-named",
      },
      "h-null-branch": { status: "rejected", resolved_at: agoIso(3 * GRACE_MS), branch_name: null },
      "h-no-branch": { status: "expired", resolved_at: agoIso(4 * GRACE_MS) },
      "h-recent": { status: "completed", resolved_at: agoIso(GRACE_MS - 1) },
    }),
  });
  expect(got).toEqual([
    {
      handoff_id: "h-named",
      branch: "fix/orphan_h-named",
      status: "failed",
      resolved_at: agoIso(2 * GRACE_MS),
      path: "/wt/h-named",
      age_ms: 2 * GRACE_MS,
      reason: "terminal_orphan",
    },
    {
      handoff_id: "h-null-branch",
      branch: "agent/h-null-branch",
      status: "rejected",
      resolved_at: agoIso(3 * GRACE_MS),
      path: "/wt/h-null-branch",
      age_ms: 3 * GRACE_MS,
      reason: "terminal_orphan",
    },
    {
      handoff_id: "h-no-branch",
      branch: "agent/h-no-branch",
      status: "expired",
      resolved_at: agoIso(4 * GRACE_MS),
      path: "/wt/h-no-branch",
      age_ms: 4 * GRACE_MS,
      reason: "terminal_orphan",
    },
  ]);
});

test("an orphan whose handoff row is not terminal is skipped without reading its mtime", () => {
  const statted: string[] = [];
  const got = select({
    orphanHandles: [orphanHandle("h-running")],
    handoffReader: readerOf({ "h-running": { status: "dispatched", resolved_at: null } }),
    getFileMtime: (targetPath: string): number => {
      statted.push(targetPath);
      return NOW_MS - 100 * GRACE_MS;
    },
  });
  expect(got).toEqual([]);
  expect(statted).toEqual([]);
});

test("an orphan with no handoff row and an mtime past the grace period is missing_handoff_orphan", () => {
  const mtimeMs = NOW_MS - 2 * GRACE_MS;
  const got = select({
    orphanHandles: [orphanHandle("h-missing")],
    getFileMtime: mtimeFrom({ "/wt/h-missing": mtimeMs }),
  });
  expect(got).toEqual([
    {
      handoff_id: "h-missing",
      branch: "agent/h-missing",
      status: "missing",
      resolved_at: new Date(mtimeMs).toISOString(),
      path: "/wt/h-missing",
      age_ms: 2 * GRACE_MS,
      reason: "missing_handoff_orphan",
    },
  ]);
});

test("a missing-handoff orphan exactly gracePeriodMs old is a candidate and 1 ms newer is not", () => {
  const got = select({
    orphanHandles: [orphanHandle("h-at-grace"), orphanHandle("h-in-grace")],
    getFileMtime: mtimeFrom({
      "/wt/h-at-grace": NOW_MS - GRACE_MS,
      "/wt/h-in-grace": NOW_MS - GRACE_MS + 1,
    }),
  });
  expect(got.map((c): string => c.handoff_id)).toEqual(["h-at-grace"]);
  expect(got[0]?.age_ms).toBe(GRACE_MS);
});

test("a getFileMtime that throws skips that orphan and keeps the others", () => {
  const got = select({
    orphanHandles: [orphanHandle("h-unreadable"), orphanHandle("h-stale")],
    getFileMtime: mtimeFrom({ "/wt/h-stale": NOW_MS - 2 * GRACE_MS }),
  });
  expect(got.map((c): string => c.handoff_id)).toEqual(["h-stale"]);
});

test("candidates are sorted by ascending age_ms across tracked and orphan worktrees", () => {
  const got = select({
    trackedHandles: [trackedHandle("h-a"), trackedHandle("h-d")],
    orphanHandles: [orphanHandle("h-b"), orphanHandle("h-c")],
    handoffReader: readerOf({
      "h-a": { status: "completed", resolved_at: agoIso(5 * GRACE_MS) },
      "h-d": { status: "failed", resolved_at: agoIso(4 * GRACE_MS) },
      "h-b": { status: "expired", resolved_at: agoIso(3 * GRACE_MS), branch_name: null },
    }),
    getFileMtime: mtimeFrom({ "/wt/h-c": NOW_MS - 2 * GRACE_MS }),
  });
  expect(got.map((c): string => c.handoff_id)).toEqual(["h-c", "h-b", "h-d", "h-a"]);
  expect(got.map((c): number => c.age_ms)).toEqual([
    2 * GRACE_MS,
    3 * GRACE_MS,
    4 * GRACE_MS,
    5 * GRACE_MS,
  ]);
  expect(got.map((c): string => c.reason)).toEqual([
    "missing_handoff_orphan",
    "terminal_orphan",
    "terminal_tracked",
    "terminal_tracked",
  ]);
});
