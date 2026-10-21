import { loadSqliteVec, migrate, T0Writer, TaskWriter } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type {
  GhClient,
  GhIssueComment,
  GhIssueState,
  GhIssueStateReason,
} from "@src/services/gh-client.js";
import {
  createGhTaskSyncService,
  createGhTaskSyncSweeper,
  type GhTaskSyncService,
} from "@src/sweepers/gh-task-sync.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  void 0;
}

const REPO = "frozename/penumbra";
const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const PRIOR_CURSOR = "2026-10-20T11:50:00Z";
const SERVER_TIME = "2026-10-20T12:00:00.000Z";
const CURSOR_AFTER_SERVER_TIME = "2026-10-20T11:58:00Z";

interface FakeIssue {
  state: GhIssueState;
  stateReason: GhIssueStateReason;
  updatedAt: string;
  comments: GhIssueComment[];
}

interface Harness {
  db: Database;
  writer: TaskWriter;
  service: GhTaskSyncService;
  calls: string[];
  issues: Map<number, FakeIssue>;
  cursors: Map<string, string>;
  listing: {
    changed: number[];
    serverTime: string | null;
    fail: boolean;
  };
  failView: Set<number>;
  viewGate: { wait: Promise<void> | null };
  clock: { ms: number };
  sweep(): Promise<void>;
}

function closedIssue(reason: GhIssueStateReason = "NOT_PLANNED"): FakeIssue {
  return { state: "CLOSED", stateReason: reason, updatedAt: "2026-10-01T00:00:00Z", comments: [] };
}

function openIssue(): FakeIssue {
  return { state: "OPEN", stateReason: null, updatedAt: "2026-10-01T00:00:00Z", comments: [] };
}

function makeClient(h: Omit<Harness, "service" | "sweep" | "db" | "writer">): GhClient {
  const issue = (n: number): FakeIssue => {
    const found = h.issues.get(n);
    if (!found) throw new Error(`no fake issue ${String(n)}`);
    return found;
  };
  const client: GhClient = {
    createIssue: () => Promise.reject(new Error("unused")),
    viewIssue: async (_repo, n) => {
      h.calls.push(`view ${String(n)}`);
      if (h.viewGate.wait) await h.viewGate.wait;
      if (h.failView.has(n)) throw new Error("gh: HTTP 502");
      const it = issue(n);
      return {
        number: n,
        state: it.state,
        stateReason: it.stateReason,
        updatedAt: it.updatedAt,
        title: `Issue ${String(n)}`,
        url: `https://github.com/${REPO}/issues/${String(n)}`,
      };
    },
    closeIssue: (_repo, n) => {
      h.calls.push(`close ${String(n)}`);
      issue(n).state = "CLOSED";
      return Promise.resolve();
    },
    reopenIssue: (_repo, n) => {
      h.calls.push(`reopen ${String(n)}`);
      issue(n).state = "OPEN";
      return Promise.resolve();
    },
    commentIssue: () => Promise.reject(new Error("unused")),
    listComments: (_repo, n) => {
      h.calls.push(`comments ${String(n)}`);
      return Promise.resolve(issue(n).comments);
    },
    listIssuesUpdatedSince: (repo, since) => {
      h.calls.push(`since ${repo} ${since}`);
      if (h.listing.fail) return Promise.reject(new Error("gh: HTTP 503"));
      return Promise.resolve({
        serverTime: h.listing.serverTime,
        issues: h.listing.changed.map((number) => ({
          number,
          updatedAt: issue(number).updatedAt,
        })),
      });
    },
  };
  return client;
}

function setup(): Harness {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const clock = { ms: NOW };
  const writer = new TaskWriter(db, { now: (): number => clock.ms });
  const partial = {
    calls: [] as string[],
    issues: new Map<number, FakeIssue>(),
    cursors: new Map<string, string>([[REPO, PRIOR_CURSOR]]),
    listing: { changed: [] as number[], serverTime: SERVER_TIME as string | null, fail: false },
    failView: new Set<number>(),
    viewGate: { wait: null as Promise<void> | null },
    clock,
  };
  const service = createGhTaskSyncService({
    taskWriter: writer,
    ghClient: makeClient(partial),
    t0Writer: new T0Writer(db),
    now: () => new Date(clock.ms),
    uuid: () => crypto.randomUUID(),
    userId: "test",
    machineId: "test",
    reconcileCursors: {
      get: (repo: string): string | null => partial.cursors.get(repo) ?? null,
      set: (repo: string, since: string): void => {
        partial.cursors.set(repo, since);
      },
    },
  });
  const sweeper = createGhTaskSyncSweeper({ service, now: () => clock.ms });
  return {
    ...partial,
    db,
    writer,
    service,
    sweep: async (): Promise<void> => {
      await sweeper.tick();
    },
  };
}

function seedTask(
  h: Harness,
  issue: number,
  state: { status: string; updatedAt: number; syncedAt: number | null },
): string {
  const { task_id } = h.writer.file({
    prompt: `task for #${String(issue)}`,
    created_by_kind: "human",
    created_by_id: "cli",
  });
  h.writer.linkGhIssue(task_id, { repo: REPO, issue_number: issue });
  h.db.run(`UPDATE tasks SET status = ?, updated_at = ?, gh_comments_synced_at = ? WHERE id = ?`, [
    state.status,
    state.updatedAt,
    state.syncedAt,
    task_id,
  ]);
  return task_id;
}

function seedStaleTerminal(h: Harness, issue: number, status = "cancelled"): string {
  return seedTask(h, issue, { status, updatedAt: NOW - 8 * DAY, syncedAt: NOW - 8 * DAY + 1_000 });
}

function mirroredCommentIds(h: Harness, task_id: string): string[] {
  return h.db
    .query<{ payload_json: string }, []>(
      `SELECT payload_json FROM t0_events WHERE event_type = 'gh_issue_comment'`,
    )
    .all()
    .map((row) => JSON.parse(row.payload_json) as { task_id: string; comment_id: string })
    .filter((payload) => payload.task_id === task_id)
    .map((payload) => payload.comment_id);
}

function comment(id: string, author: string, created_at: string): GhIssueComment {
  return { id, author_login: author, body: `comment ${id}`, created_at, url: `u/${id}` };
}

function ghCallsFor(h: Harness, issue: number): string[] {
  return h.calls.filter((call) => call.endsWith(` ${String(issue)}`));
}

describe("gh-task-sync scoped reconcile (GitHub-side change detection)", () => {
  test("a reopen plus a comment on a task terminal for 8 days are picked up", async () => {
    const h = setup();
    const task_id = seedStaleTerminal(h, 12);
    h.issues.set(12, {
      ...openIssue(),
      updatedAt: "2026-10-20T11:58:00Z",
      comments: [comment("9001", "alice", "2026-10-20T11:58:00Z")],
    });
    h.listing.changed = [12];

    await h.sweep();

    expect(h.writer.get(task_id).status).toBe("pending");
    expect(mirroredCommentIds(h, task_id)).toEqual(["9001"]);
  });

  test("inbound comments on a closed issue are still mirrored after 8 days", async () => {
    const h = setup();
    const task_id = seedStaleTerminal(h, 13, "done");
    h.issues.set(13, {
      ...closedIssue("COMPLETED"),
      updatedAt: "2026-10-20T11:59:00Z",
      comments: [comment("9002", "bob", "2026-10-20T11:59:00Z")],
    });
    h.listing.changed = [13];

    await h.sweep();

    expect(h.writer.get(task_id).status).toBe("done");
    expect(mirroredCommentIds(h, task_id)).toEqual(["9002"]);
  });

  test("an unchanged terminal task makes zero gh calls", async () => {
    const h = setup();
    seedTask(h, 20, { status: "pending", updatedAt: NOW - DAY, syncedAt: NOW - DAY });
    const recentlyDone = seedTask(h, 21, {
      status: "done",
      updatedAt: NOW - 2 * DAY,
      syncedAt: NOW - 2 * DAY + 1_000,
    });
    seedStaleTerminal(h, 22);
    h.issues.set(20, openIssue());
    h.issues.set(21, closedIssue("COMPLETED"));
    h.issues.set(22, { ...closedIssue(), updatedAt: "2026-10-20T11:55:00Z" });
    h.listing.changed = [22];

    await h.sweep();

    expect(ghCallsFor(h, 21)).toEqual([]);
    expect(h.writer.get(recentlyDone).status).toBe("done");
    expect(h.calls).toEqual([
      `since ${REPO} ${PRIOR_CURSOR}`,
      "view 20",
      "view 22",
      "comments 20",
      "comments 22",
    ]);
  });

  test("a failed push for a task terminal for 8 days is still retried", async () => {
    const h = setup();
    const task_id = seedTask(h, 30, {
      status: "cancelled",
      updatedAt: NOW - 8 * DAY,
      syncedAt: NOW - 9 * DAY,
    });
    h.issues.set(30, { ...openIssue(), updatedAt: "2026-10-10T00:00:00Z" });

    await h.sweep();

    expect(ghCallsFor(h, 30)).toEqual(["view 30", "close 30", "comments 30"]);
    expect(h.issues.get(30)?.state).toBe("CLOSED");
    h.calls.length = 0;
    h.clock.ms += 300_001;
    await h.sweep();
    expect(ghCallsFor(h, 30)).toEqual([]);
    expect(h.writer.get(task_id).status).toBe("cancelled");
  });

  test("manual sync-all stays a full unscoped reconcile", async () => {
    const h = setup();
    const task_id = seedStaleTerminal(h, 14);
    h.issues.set(14, { ...openIssue(), updatedAt: "2026-10-20T11:00:00Z" });
    h.listing.changed = [];

    await h.service.syncAllLinkedTasks();

    expect(h.calls).toEqual(["view 14", "comments 14"]);
    expect(h.writer.get(task_id).status).toBe("pending");
    expect(h.cursors.get(REPO)).toBe(PRIOR_CURSOR);
  });

  test("a failed since call falls back to the full reconcile and keeps the cursor", async () => {
    const h = setup();
    const task_id = seedStaleTerminal(h, 15);
    h.issues.set(15, { ...openIssue(), updatedAt: "2026-10-20T11:30:00Z" });
    h.listing.fail = true;

    await h.sweep();

    expect(ghCallsFor(h, 15)).toEqual(["view 15", "comments 15"]);
    expect(h.writer.get(task_id).status).toBe("pending");
    expect(h.cursors.get(REPO)).toBe(PRIOR_CURSOR);
  });

  test("a missing cursor falls back to the full reconcile and starts one from server time", async () => {
    const h = setup();
    h.cursors.clear();
    seedStaleTerminal(h, 16);
    h.issues.set(16, closedIssue());

    await h.sweep();

    expect(ghCallsFor(h, 16)).toEqual(["view 16", "comments 16"]);
    expect(h.cursors.get(REPO)).toBe(CURSOR_AFTER_SERVER_TIME);
  });

  test("the cursor advances to server time minus the overlap and feeds the next sweep", async () => {
    const h = setup();
    seedStaleTerminal(h, 17);
    h.issues.set(17, { ...closedIssue(), updatedAt: "2026-10-20T11:52:00Z" });
    h.listing.changed = [17];

    await h.sweep();
    expect(h.cursors.get(REPO)).toBe(CURSOR_AFTER_SERVER_TIME);

    h.calls.length = 0;
    h.listing.changed = [];
    h.listing.serverTime = null;
    h.clock.ms += 300_001;
    await h.sweep();
    expect(h.calls).toEqual([`since ${REPO} ${CURSOR_AFTER_SERVER_TIME}`]);
    expect(h.cursors.get(REPO)).toBe(CURSOR_AFTER_SERVER_TIME);
  });

  test("without a server time the cursor uses the newest updated_at minus the overlap", async () => {
    const h = setup();
    seedStaleTerminal(h, 18);
    h.issues.set(18, { ...closedIssue(), updatedAt: "2026-10-20T11:57:30Z" });
    h.listing.changed = [18];
    h.listing.serverTime = null;

    await h.sweep();

    expect(h.cursors.get(REPO)).toBe("2026-10-20T11:55:30Z");
  });

  test("a changed terminal task whose sync fails is retried on the next sweep", async () => {
    const h = setup();
    const task_id = seedStaleTerminal(h, 19);
    h.issues.set(19, { ...openIssue(), updatedAt: "2026-10-20T11:56:00Z" });
    h.listing.changed = [19];
    h.failView.add(19);

    await h.sweep();
    expect(h.writer.get(task_id).status).toBe("cancelled");

    h.failView.clear();
    h.listing.changed = [];
    h.calls.length = 0;
    h.clock.ms += 300_001;
    await h.sweep();
    expect(ghCallsFor(h, 19)).toEqual(["view 19", "comments 19"]);
    expect(h.writer.get(task_id).status).toBe("pending");
  });

  test("a changed task already being synced holds the cursor back", async () => {
    const h = setup();
    const task_id = seedStaleTerminal(h, 23);
    h.issues.set(23, { ...closedIssue(), updatedAt: "2026-10-20T11:59:00Z" });
    h.listing.changed = [23];
    let release: () => void = () => undefined;
    h.viewGate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = h.service.syncLinkedTask(task_id);

    await h.sweep();
    release();
    await inFlight;

    expect(h.cursors.get(REPO)).toBe(PRIOR_CURSOR);
  });
});
