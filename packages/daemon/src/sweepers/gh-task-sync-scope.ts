import type { Database } from "bun:sqlite";

import type { GhClient, GhIssuesUpdatedSince } from "../services/gh-client.js";

export interface GhReconcileCursorStore {
  get(repo: string): string | null;
  set(repo: string, since: string): void;
}

interface ScopeTask {
  id: string;
  status: string;
  updated_at: number;
  gh_issue_repo?: string | null;
  gh_issue_number?: number | null;
  gh_comments_synced_at?: number | null;
}

interface ScopeResult {
  task_id: string;
  repo: string;
  action: string;
}

interface ScopeDeps<T extends ScopeTask> {
  ghClient: GhClient;
  reconcileCursors?: GhReconcileCursorStore;
  taskWriter: {
    get(task_id: string): T;
    setGhCommentsSyncedAt(task_id: string, synced_at: number): unknown;
  };
  now: () => Date;
  log?: {
    info?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  };
}

interface RepoScan {
  changed: Set<number> | null;
  nextSince: string | null;
}

interface ChangedOnlyReconcile<T> {
  tasks: T[];
  commit(results: ScopeResult[]): void;
}

const CURSOR_KEY_PREFIX = "gh_task_sync.issues_since:";
const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);
// GitHub's `since` filter and Date header have one-second resolution, and a
// write can surface in the listing a moment after its updated_at. Re-reading a
// short window costs at most one extra sync per change; a gap loses the change.
const GH_RECONCILE_CURSOR_OVERLAP_MS = 2 * 60 * 1000;

export function createGhReconcileCursorStore(db: Database): GhReconcileCursorStore {
  return {
    get: (repo: string): string | null =>
      db
        .query<{ value: string }, [string]>(`SELECT value FROM db_meta WHERE key = ?`)
        .get(`${CURSOR_KEY_PREFIX}${repo}`)?.value ?? null,
    set: (repo: string, since: string): void => {
      db.run(
        `INSERT INTO db_meta(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [`${CURSOR_KEY_PREFIX}${repo}`, since],
      );
    },
  };
}

function toSinceParam(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isTerminal(task: ScopeTask): boolean {
  return TERMINAL_STATUSES.has(task.status);
}

// A terminal task stops being re-synced only once a full sync (which stamps
// gh_comments_synced_at) has run after its last local change; until then a
// failed gh_push_status still gets retried by the reconcile.
function hasUnsyncedLocalChange(task: ScopeTask): boolean {
  const syncedAt = task.gh_comments_synced_at;
  return syncedAt === null || syncedAt === undefined || task.updated_at > syncedAt;
}

function nextSinceFrom(listing: GhIssuesUpdatedSince): string | null {
  const newest = listing.issues.reduce(
    (max, issue) => Math.max(max, Date.parse(issue.updatedAt) || 0),
    0,
  );
  const reference = listing.serverTime ? Date.parse(listing.serverTime) : newest;
  if (!Number.isFinite(reference) || reference <= 0) return null;
  return toSinceParam(reference - GH_RECONCILE_CURSOR_OVERLAP_MS);
}

async function scanRepo<T extends ScopeTask>(
  deps: ScopeDeps<T>,
  list: NonNullable<GhClient["listIssuesUpdatedSince"]>,
  repo: string,
): Promise<RepoScan> {
  const cursor = deps.reconcileCursors?.get(repo) ?? null;
  try {
    // Without a cursor the listing only supplies GitHub's clock to start one;
    // the local time is a filter that keeps that response small, never a cursor.
    const listing = await list(repo, cursor ?? toSinceParam(deps.now().getTime()));
    const changed = cursor ? new Set(listing.issues.map((issue) => issue.number)) : null;
    return { changed, nextSince: nextSinceFrom(listing) };
  } catch (error) {
    deps.log?.warn?.(
      { repo, err: error instanceof Error ? error.message : String(error) },
      "gh-task-sync: changed-issue listing failed; reconciling every linked task in repo",
    );
    return { changed: null, nextSince: null };
  }
}

function needsSync(task: ScopeTask, scans: Map<string, RepoScan>): boolean {
  if (!isTerminal(task) || hasUnsyncedLocalChange(task)) return true;
  const changed = scans.get(task.gh_issue_repo ?? "")?.changed;
  return !changed || changed.has(task.gh_issue_number ?? 0);
}

// The cursor still advances past a change whose sync failed; rewinding the
// task's sync stamp below updated_at makes the next reconcile retry it anyway.
function markForRetry<T extends ScopeTask>(deps: ScopeDeps<T>, task_id: string): void {
  const task = deps.taskWriter.get(task_id);
  if (!isTerminal(task) || hasUnsyncedLocalChange(task)) return;
  deps.taskWriter.setGhCommentsSyncedAt(task_id, Math.max(0, task.updated_at - 1));
}

function commitScans<T extends ScopeTask>(
  deps: ScopeDeps<T>,
  scans: Map<string, RepoScan>,
  results: ScopeResult[],
): void {
  const heldBack = new Set<string>();
  for (const result of results) {
    if (result.action === "error") markForRetry(deps, result.task_id);
    if (result.action === "already_in_progress") heldBack.add(result.repo);
  }
  for (const [repo, scan] of scans) {
    if (scan.nextSince && !heldBack.has(repo)) deps.reconcileCursors?.set(repo, scan.nextSince);
  }
}

/**
 * Narrows a sweeper reconcile to the linked tasks that can have drifted: every
 * non-terminal task, every terminal task changed locally since its last full
 * sync, and every terminal task whose issue GitHub reports as updated since the
 * repo's cursor. A repo without a cursor, or whose listing fails, is reconciled
 * in full. Returns null when change detection is unavailable.
 */
export async function planChangedOnlyReconcile<T extends ScopeTask>(
  deps: ScopeDeps<T>,
  linked: T[],
): Promise<ChangedOnlyReconcile<T> | null> {
  const list = deps.ghClient.listIssuesUpdatedSince?.bind(deps.ghClient);
  if (!deps.reconcileCursors || !list) return null;
  const repos = [...new Set(linked.map((task) => task.gh_issue_repo ?? ""))].filter(Boolean);
  const scans = new Map(
    await Promise.all(repos.map(async (repo) => [repo, await scanRepo(deps, list, repo)] as const)),
  );
  const tasks = linked.filter((task) => needsSync(task, scans));
  deps.log?.info?.(
    { linked: linked.length, selected: tasks.length },
    `gh-task-sync: changed-only reconcile selected ${String(tasks.length)} of ${String(linked.length)} linked tasks`,
  );
  return {
    tasks,
    commit: (results): void => {
      commitScans(deps, scans, results);
    },
  };
}
