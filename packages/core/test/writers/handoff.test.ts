import { HandoffEventBus } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { HandoffTransitionBus, type LeftDispatchedEvent } from "@src/events/handoff-transitions.js";
import type { HandoffRow } from "@src/schemas/handoff.js";
import { HandoffWriter } from "@src/writers/handoff.js";
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

let db: Database;
let writer: HandoffWriter;

beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  writer = new HandoffWriter({ db });
});

function createApprovedHandoff(
  handoff_id: string,
  opts: {
    to?: string;
    dispatch_kind?: "workflow" | null;
    workflow_run_id?: string | null;
    resolved_at?: string | null;
  } = {},
): void {
  writer.createApproved({
    handoff_id,
    ts: "2026-05-11T00:00:00Z",
    conversation_id: `conv-${handoff_id}`,
    from: "a",
    to: opts.to ?? "b",
    to_role: null,
    message: "m",
    project_id: null,
    triggered_by_event_id: null,
    resolved_by: "u",
    resolved_at: opts.resolved_at ?? null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
    dispatch_kind: opts.dispatch_kind ?? null,
    workflow_run_id: opts.workflow_run_id ?? null,
  });
}

function captureTransitions(): LeftDispatchedEvent[] {
  const bus = new HandoffTransitionBus();
  const seen: LeftDispatchedEvent[] = [];
  bus.subscribe((event) => seen.push(event));
  writer = new HandoffWriter({ db, transitions: bus });
  return seen;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function readHandoffStatus(handoff_id: string): {
  status: string;
  worker_id: string | null;
  resolution_reason: string | null;
  resolved_at: string | null;
} {
  const row = db
    .query<
      {
        status: string;
        worker_id: string | null;
        resolution_reason: string | null;
        resolved_at: string | null;
      },
      [string]
    >("SELECT status, worker_id, resolution_reason, resolved_at FROM handoffs WHERE handoff_id=?")
    .get(handoff_id);
  if (!row) throw new Error(`missing handoff ${handoff_id}`);
  return row;
}

test("markCompleted() emits left_dispatched{to_status:'completed', to_agent} on the transition bus", () => {
  const seen = captureTransitions();
  createApprovedHandoff("h-complete-emit", { to: "seat-a" });
  expect(writer.claimDispatch("h-complete-emit", "w1")).toBe(true);

  expect(writer.markCompleted("h-complete-emit", { expected_worker_id: "w1" })).toBe(true);
  expect(seen.map(({ ts: _ts, ...event }) => event)).toEqual([
    {
      kind: "left_dispatched",
      handoff_id: "h-complete-emit",
      to_agent: "seat-a",
      to_status: "completed",
    },
  ]);
  expect(typeof seen[0]?.ts).toBe("string");
});

test("markCompleted() on a cancel-requested row returns false and emits nothing", () => {
  const seen = captureTransitions();
  createApprovedHandoff("h-complete-cancel-no-emit", { to: "seat-a" });
  expect(writer.claimDispatch("h-complete-cancel-no-emit", "w1")).toBe(true);
  writer.requestCancellation("conv-h-complete-cancel-no-emit", "cancel-ts");

  expect(writer.markCompleted("h-complete-cancel-no-emit", { expected_worker_id: "w1" })).toBe(
    false,
  );
  expect(readHandoffStatus("h-complete-cancel-no-emit").status).toBe("dispatched");
  expect(seen).toEqual([]);
});

test("markFailed() on a dispatched row emits left_dispatched{to_status:'failed'} with and without expected_worker_id", () => {
  const seen = captureTransitions();
  createApprovedHandoff("h-fail-emit-a", { to: "seat-a" });
  createApprovedHandoff("h-fail-emit-b", { to: "seat-b" });
  expect(writer.claimDispatch("h-fail-emit-a", "w1")).toBe(true);
  expect(writer.claimDispatch("h-fail-emit-b", "w2")).toBe(true);

  expect(writer.markFailed("h-fail-emit-a", { reason: "crash", expected_worker_id: "w1" })).toBe(
    true,
  );
  expect(writer.markFailed("h-fail-emit-b", { reason: "crash" })).toBe(true);
  expect(seen.map(({ ts: _ts, ...event }) => event)).toEqual([
    {
      kind: "left_dispatched",
      handoff_id: "h-fail-emit-a",
      to_agent: "seat-a",
      to_status: "failed",
    },
    {
      kind: "left_dispatched",
      handoff_id: "h-fail-emit-b",
      to_agent: "seat-b",
      to_status: "failed",
    },
  ]);
  expect(seen.every((event) => typeof event.ts === "string")).toBe(true);
});

test("markFailed() on an approved row returns true and emits nothing", () => {
  const seen = captureTransitions();
  createApprovedHandoff("h-fail-approved-no-emit", { to: "seat-a" });

  expect(writer.markFailed("h-fail-approved-no-emit", { reason: "cancelled" })).toBe(true);
  expect(readHandoffStatus("h-fail-approved-no-emit").status).toBe("failed");
  expect(seen).toEqual([]);
});

test("markFailed() on an expired row returns true and emits nothing", () => {
  const seen = captureTransitions();
  createApprovedHandoff("h-fail-expired-no-emit", { to: "seat-a" });
  db.query("UPDATE handoffs SET status='expired' WHERE handoff_id='h-fail-expired-no-emit'").run();

  expect(writer.markFailed("h-fail-expired-no-emit", { reason: "terminal cleanup" })).toBe(true);
  expect(readHandoffStatus("h-fail-expired-no-emit").status).toBe("failed");
  expect(seen).toEqual([]);
});

test("markFailed() with a mismatched expected_worker_id on a dispatched row returns false, leaves the row dispatched, emits nothing", () => {
  const seen = captureTransitions();
  createApprovedHandoff("h-fail-worker-mismatch", { to: "seat-a" });
  expect(writer.claimDispatch("h-fail-worker-mismatch", "worker-a")).toBe(true);

  expect(
    writer.markFailed("h-fail-worker-mismatch", {
      reason: "wrong worker",
      expected_worker_id: "worker-b",
    }),
  ).toBe(false);
  expect(readHandoffStatus("h-fail-worker-mismatch")).toMatchObject({
    status: "dispatched",
    worker_id: "worker-a",
  });
  expect(seen).toEqual([]);
});

test("requeueOrphanedDispatch() emits left_dispatched{to_status:'approved'}", () => {
  const seen = captureTransitions();
  createApprovedHandoff("h-requeue-emit", { to: "seat-a" });
  expect(writer.claimDispatch("h-requeue-emit", "dead-worker")).toBe(true);

  expect(writer.requeueOrphanedDispatch("h-requeue-emit", "dead-worker")).toBe(true);
  expect(readHandoffStatus("h-requeue-emit")).toMatchObject({
    status: "approved",
    worker_id: null,
  });
  expect(seen.map(({ ts: _ts, ...event }) => event)).toEqual([
    {
      kind: "left_dispatched",
      handoff_id: "h-requeue-emit",
      to_agent: "seat-a",
      to_status: "approved",
    },
  ]);
  expect(typeof seen[0]?.ts).toBe("string");
});

test("requeueOrphanedDispatch() with a different worker_id returns false and emits nothing", () => {
  const seen = captureTransitions();
  createApprovedHandoff("h-requeue-mismatch", { to: "seat-a" });
  expect(writer.claimDispatch("h-requeue-mismatch", "worker-a")).toBe(true);

  expect(writer.requeueOrphanedDispatch("h-requeue-mismatch", "worker-b")).toBe(false);
  expect(readHandoffStatus("h-requeue-mismatch")).toMatchObject({
    status: "dispatched",
    worker_id: "worker-a",
  });
  expect(seen).toEqual([]);
});

test("failOrphanedDispatchExhausted() emits left_dispatched{to_status:'failed'}", () => {
  const seen = captureTransitions();
  createApprovedHandoff("h-exhausted-emit", { to: "seat-a" });
  expect(writer.claimDispatch("h-exhausted-emit", "dead-worker")).toBe(true);

  expect(writer.failOrphanedDispatchExhausted("h-exhausted-emit", "dead-worker")).toBe(true);
  expect(readHandoffStatus("h-exhausted-emit").resolution_reason).toBe(
    "failed_worker_restart: attempts exhausted",
  );
  expect(seen.map(({ ts: _ts, ...event }) => event)).toEqual([
    {
      kind: "left_dispatched",
      handoff_id: "h-exhausted-emit",
      to_agent: "seat-a",
      to_status: "failed",
    },
  ]);
  expect(typeof seen[0]?.ts).toBe("string");
});

test("expireDispatchedIdle() expires a dispatched row with no recent dispatch_events and emits left_dispatched{to_status:'expired'}", () => {
  const seen = captureTransitions();
  createApprovedHandoff("h-expire-emit", { to: "seat-a" });
  expect(writer.claimDispatch("h-expire-emit", "worker-1")).toBe(true);

  expect(
    writer.expireDispatchedIdle("h-expire-emit", {
      ts: "2026-05-11T00:10:00.000Z",
      reason: "idle timeout",
      activitySinceIso: "2026-05-11T00:05:00.000Z",
    }),
  ).toBe(true);
  expect(readHandoffStatus("h-expire-emit")).toMatchObject({
    status: "expired",
    resolution_reason: "idle timeout",
    resolved_at: "2026-05-11T00:10:00.000Z",
  });
  expect(seen).toEqual([
    {
      kind: "left_dispatched",
      handoff_id: "h-expire-emit",
      to_agent: "seat-a",
      to_status: "expired",
      ts: "2026-05-11T00:10:00.000Z",
    },
  ]);
});

test("expireDispatchedIdle() returns false and emits nothing when a dispatch_event at or after activitySinceIso exists", () => {
  const seen = captureTransitions();
  createApprovedHandoff("h-expire-recent-event", { to: "seat-a" });
  expect(writer.claimDispatch("h-expire-recent-event", "worker-1")).toBe(true);
  db.query(
    `INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "h-expire-recent-event",
    "worker-1",
    "worker",
    "agent.heartbeat",
    "2026-05-11T00:06:00.000Z",
    "{}",
  );

  expect(
    writer.expireDispatchedIdle("h-expire-recent-event", {
      ts: "2026-05-11T00:10:00.000Z",
      reason: "idle timeout",
      activitySinceIso: "2026-05-11T00:05:00.000Z",
    }),
  ).toBe(false);
  expect(readHandoffStatus("h-expire-recent-event").status).toBe("dispatched");
  expect(seen).toEqual([]);
});

test("exitDispatched writes exactly the emitted to_status for every transition", () => {
  const seen = captureTransitions();
  for (const id of [
    "h-exit-complete",
    "h-exit-fail",
    "h-exit-requeue",
    "h-exit-exhausted",
    "h-exit-expire",
  ]) {
    createApprovedHandoff(id, { to: `seat-${id}` });
    expect(writer.claimDispatch(id, `worker-${id}`)).toBe(true);
  }

  expect(
    writer.markCompleted("h-exit-complete", { expected_worker_id: "worker-h-exit-complete" }),
  ).toBe(true);
  expect(writer.markFailed("h-exit-fail", { reason: "crash" })).toBe(true);
  expect(writer.requeueOrphanedDispatch("h-exit-requeue", "worker-h-exit-requeue")).toBe(true);
  expect(writer.failOrphanedDispatchExhausted("h-exit-exhausted", "worker-h-exit-exhausted")).toBe(
    true,
  );
  expect(
    writer.expireDispatchedIdle("h-exit-expire", {
      ts: "2026-05-11T00:10:00.000Z",
      reason: "idle timeout",
      activitySinceIso: "2026-05-11T00:05:00.000Z",
    }),
  ).toBe(true);

  expect(seen.map((event) => event.to_status)).toEqual([
    "completed",
    "failed",
    "approved",
    "failed",
    "expired",
  ]);
  for (const event of seen) {
    expect(readHandoffStatus(event.handoff_id).status).toBe(event.to_status);
  }
});

test("an exit inside a transaction that rolls back emits nothing", async () => {
  const seen = captureTransitions();
  createApprovedHandoff("h-exit-rollback", { to: "seat-a" });
  expect(writer.claimDispatch("h-exit-rollback", "worker-a")).toBe(true);

  expect(() =>
    db.transaction(() => {
      writer.markCompleted("h-exit-rollback", { expected_worker_id: "worker-a" });
      throw new Error("boom");
    })(),
  ).toThrow("boom");

  await flushMicrotasks();
  expect(readHandoffStatus("h-exit-rollback").status).toBe("dispatched");
  expect(seen).toEqual([]);
});

test("an exit inside a transaction that commits emits exactly once after commit", async () => {
  const seen = captureTransitions();
  createApprovedHandoff("h-exit-commit", { to: "seat-a" });
  expect(writer.claimDispatch("h-exit-commit", "worker-a")).toBe(true);

  db.transaction(() => {
    expect(writer.markCompleted("h-exit-commit", { expected_worker_id: "worker-a" })).toBe(true);
  })();

  expect(seen).toEqual([]);
  await flushMicrotasks();
  expect(seen.map(({ ts: _ts, ...event }) => event)).toEqual([
    {
      kind: "left_dispatched",
      handoff_id: "h-exit-commit",
      to_agent: "seat-a",
      to_status: "completed",
    },
  ]);
});

test("an exit outside any transaction emits synchronously", () => {
  const seen = captureTransitions();
  createApprovedHandoff("h-exit-sync", { to: "seat-a" });
  expect(writer.claimDispatch("h-exit-sync", "worker-a")).toBe(true);

  expect(writer.markCompleted("h-exit-sync", { expected_worker_id: "worker-a" })).toBe(true);

  expect(seen.map(({ ts: _ts, ...event }) => event)).toEqual([
    {
      kind: "left_dispatched",
      handoff_id: "h-exit-sync",
      to_agent: "seat-a",
      to_status: "completed",
    },
  ]);
});

test("markFailed() on a dispatched row inside an outer db.transaction emits once and commits", async () => {
  const seen = captureTransitions();
  createApprovedHandoff("h-fail-outer-tx", { to: "seat-a" });
  expect(writer.claimDispatch("h-fail-outer-tx", "worker-a")).toBe(true);

  const result = db.transaction(() =>
    writer.markFailed("h-fail-outer-tx", { reason: "crash", expected_worker_id: "worker-a" }),
  )();

  expect(result).toBe(true);
  expect(readHandoffStatus("h-fail-outer-tx").status).toBe("failed");
  await flushMicrotasks();
  expect(seen.map(({ ts: _ts, ...event }) => event)).toEqual([
    {
      kind: "left_dispatched",
      handoff_id: "h-fail-outer-tx",
      to_agent: "seat-a",
      to_status: "failed",
    },
  ]);
});

test("expirePendingOlderThan() expires only pending rows older than the cutoff, returns the count, emits nothing", () => {
  const seen = captureTransitions();
  writer.create({
    handoff_id: "h-pending-old",
    ts: "2026-05-11T00:00:00.000Z",
    conversation_id: "c-pending-old",
    from: "a",
    to: "seat-a",
    to_role: null,
    message: "m",
    project_id: null,
    triggered_by_event_id: "e-old",
  });
  writer.create({
    handoff_id: "h-pending-new",
    ts: "2026-05-11T00:10:00.000Z",
    conversation_id: "c-pending-new",
    from: "a",
    to: "seat-a",
    to_role: null,
    message: "m",
    project_id: null,
    triggered_by_event_id: "e-new",
  });
  createApprovedHandoff("h-approved-old", { to: "seat-a" });

  const count = writer.expirePendingOlderThan({
    olderThanIso: "2026-05-11T00:05:00.000Z",
    ts: "2026-05-11T00:20:00.000Z",
    reason: "pending timeout",
  });

  expect(count).toBe(1);
  expect(readHandoffStatus("h-pending-old").status).toBe("expired");
  expect(readHandoffStatus("h-pending-new").status).toBe("pending");
  expect(readHandoffStatus("h-approved-old").status).toBe("approved");
  expect(seen).toEqual([]);
});

test("a writer built without a transition bus performs every dispatched exit without throwing", () => {
  writer = new HandoffWriter({ db });
  for (const id of [
    "h-no-bus-complete",
    "h-no-bus-fail",
    "h-no-bus-requeue",
    "h-no-bus-exhausted",
    "h-no-bus-expire",
  ]) {
    createApprovedHandoff(id, { to: "seat-a" });
    expect(writer.claimDispatch(id, `worker-${id}`)).toBe(true);
  }

  expect(writer.markCompleted("h-no-bus-complete")).toBe(true);
  expect(writer.markFailed("h-no-bus-fail", { reason: "crash" })).toBe(true);
  expect(writer.requeueOrphanedDispatch("h-no-bus-requeue", "worker-h-no-bus-requeue")).toBe(true);
  expect(
    writer.failOrphanedDispatchExhausted("h-no-bus-exhausted", "worker-h-no-bus-exhausted"),
  ).toBe(true);
  expect(
    writer.expireDispatchedIdle("h-no-bus-expire", {
      ts: "2026-05-11T00:10:00.000Z",
      reason: "idle timeout",
      activitySinceIso: "2026-05-11T00:05:00.000Z",
    }),
  ).toBe(true);
});

test("create() inserts a pending handoff with the given handoff_id", () => {
  const id = writer.create({
    handoff_id: "h-1",
    ts: "2026-04-25T20:00:00.000Z",
    from: "claude", // Note: test from prompt uses from_agent, but CreateHandoffRequest in prompt schemas/handoff uses from. I'll use from based on the schema mapping in writer.create
    to: "gemini",
    to_role: "executor",
    message: "go",
    conversation_id: "conv-7",
    project_id: "auth-svc",
    triggered_by_event_id: "evt-1",
  });
  expect(id).toBe("h-1");
  const row = db
    .query<
      { status: string; from_agent: string },
      [string]
    >("SELECT status, from_agent FROM handoffs WHERE handoff_id=?")
    .get("h-1");
  expect(row?.status).toBe("pending");
  expect(row?.from_agent).toBe("claude");
});

test("create() persists isolated_install for pending handoffs", () => {
  writer.create({
    handoff_id: "h-create-isolated",
    ts: "2026-04-25T20:00:00.000Z",
    from: "claude",
    to: "gemini",
    to_role: null,
    message: "go",
    conversation_id: "conv-isolated",
    project_id: null,
    triggered_by_event_id: "evt-isolated",
    use_worktree: true,
    isolated_install: true,
  });

  const row = db
    .query<
      { use_worktree: number | null; isolated_install: number | null },
      [string]
    >("SELECT use_worktree, isolated_install FROM handoffs WHERE handoff_id=?")
    .get("h-create-isolated");
  expect(row).toEqual({ use_worktree: 1, isolated_install: 1 });
});

test("approve() transitions pending → approved and records actor + ts", () => {
  writer.create({
    handoff_id: "h-2",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c",
    project_id: null,
    triggered_by_event_id: "e",
  });
  const result = writer.approve("h-2", {
    resolved_by: "user",
    resolved_at: "2026-04-25T20:01:00Z",
  });
  expect(result.status).toBe("approved");
  const row = db
    .query<
      { status: string; resolved_by: string | null },
      [string]
    >("SELECT status, resolved_by FROM handoffs WHERE handoff_id=?")
    .get("h-2");
  expect(row?.status).toBe("approved");
  expect(row?.resolved_by).toBe("user");
});

test("approve() with redirect_to records redirected status and target", () => {
  writer.create({
    handoff_id: "h-3",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c",
    project_id: null,
    triggered_by_event_id: "e",
  });
  const result = writer.approve("h-3", {
    resolved_by: "user",
    resolved_at: "t2",
    redirect_to: "codex",
  });
  expect(result.status).toBe("redirected");
  expect(result.redirected_to).toBe("codex");
});

test("approve() rejects an already-resolved handoff with conflict", () => {
  writer.create({
    handoff_id: "h-4",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c",
    project_id: null,
    triggered_by_event_id: "e",
  });
  writer.approve("h-4", { resolved_by: "user", resolved_at: "t" });
  expect(() => writer.approve("h-4", { resolved_by: "user", resolved_at: "t" })).toThrow(
    /conflict/,
  );
});

test("claimDispatch() flips approved → dispatched atomically; only one wins", () => {
  writer.create({
    handoff_id: "h-5",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c",
    project_id: null,
    triggered_by_event_id: "e",
  });
  writer.approve("h-5", { resolved_by: "u", resolved_at: "t" });
  expect(writer.claimDispatch("h-5", "w-1")).toBe(true);
  expect(writer.claimDispatch("h-5", "w-2")).toBe(false); // already dispatched
});

test("claimDispatch() increments dispatch_attempts and stamps last_dispatch_started_at on success", () => {
  writer.createApproved({
    handoff_id: "h-claim-success",
    ts: "2026-05-11T00:00:00Z",
    conversation_id: "c1",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    project_id: null,
    triggered_by_event_id: "e",
    resolved_by: "u",
    resolved_at: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
  });

  const before = db
    .query("SELECT dispatch_attempts, last_dispatch_started_at FROM handoffs WHERE handoff_id=?")
    .get("h-claim-success");
  expect(before.dispatch_attempts).toBe(0);
  expect(before.last_dispatch_started_at).toBeNull();

  const success = writer.claimDispatch("h-claim-success", "worker-1");
  expect(success).toBe(true);

  const after = db
    .query("SELECT dispatch_attempts, last_dispatch_started_at FROM handoffs WHERE handoff_id=?")
    .get("h-claim-success");
  expect(after.dispatch_attempts).toBe(1);
  expect(after.last_dispatch_started_at).not.toBeNull();
});

test("claimDispatch() rejects claim when dispatch_attempts >= max_dispatch_attempts", () => {
  writer.createApproved({
    handoff_id: "h-claim-exhausted",
    ts: "2026-05-11T00:00:00Z",
    conversation_id: "c1",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    project_id: null,
    triggered_by_event_id: "e",
    resolved_by: "u",
    resolved_at: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
    max_dispatch_attempts: 3,
  });

  db.query(
    "UPDATE handoffs SET dispatch_attempts = 3 WHERE handoff_id = 'h-claim-exhausted'",
  ).run();

  const success = writer.claimDispatch("h-claim-exhausted", "worker-1");
  expect(success).toBe(false);
});

test("claimDispatch() refuses a cancel-requested approved row and leaves it unclaimed", () => {
  createApprovedHandoff("h-claim-cancelled");
  createApprovedHandoff("h-claim-live");
  expect(writer.requestCancellation("conv-h-claim-cancelled", "cancel-ts")).toBe(true);

  expect(writer.claimDispatch("h-claim-cancelled", "worker-1")).toBe(false);
  expect(writer.claimDispatch("h-claim-live", "worker-1")).toBe(true);

  const row = db
    .query<
      { status: string; worker_id: string | null; dispatch_attempts: number },
      [string]
    >("SELECT status, worker_id, dispatch_attempts FROM handoffs WHERE handoff_id=?")
    .get("h-claim-cancelled");
  expect(row).toEqual({ status: "approved", worker_id: null, dispatch_attempts: 0 });
});

test("claimDispatch() enforces provider in-flight cap across provider seats", () => {
  createApprovedHandoff("provider-running", { to: "claude-a" });
  createApprovedHandoff("provider-next", { to: "claude-b" });
  expect(
    writer.claimDispatch("provider-running", "worker-1", {
      providerSeatNames: ["claude-a", "claude-b"],
      maxProviderInFlight: 1,
    }),
  ).toBe(true);

  expect(
    writer.claimDispatch("provider-next", "worker-2", {
      providerSeatNames: ["claude-a", "claude-b"],
      maxProviderInFlight: 1,
    }),
  ).toBe(false);

  expect(writer.markCompleted("provider-running", { expected_worker_id: "worker-1" })).toBe(true);
  expect(
    writer.claimDispatch("provider-next", "worker-2", {
      providerSeatNames: ["claude-a", "claude-b"],
      maxProviderInFlight: 1,
    }),
  ).toBe(true);
});

test("claimDispatch() composes provider in-flight cap with workflow sibling cap", () => {
  for (const id of ["wf-a", "wf-b", "wf-c"]) {
    createApprovedHandoff(id, {
      to: "claude-a",
      dispatch_kind: "workflow",
      workflow_run_id: "wf-composed",
    });
  }

  expect(
    writer.claimDispatch("wf-a", "worker-1", {
      workflow_run_id: "wf-composed",
      maxWorkflowSiblingsPerWorker: 1,
      providerSeatNames: ["claude-a", "claude-b"],
      maxProviderInFlight: 2,
    }),
  ).toBe(true);
  expect(
    writer.claimDispatch("wf-b", "worker-1", {
      workflow_run_id: "wf-composed",
      maxWorkflowSiblingsPerWorker: 1,
      providerSeatNames: ["claude-a", "claude-b"],
      maxProviderInFlight: 2,
    }),
  ).toBe(false);
  expect(
    writer.claimDispatch("wf-b", "worker-2", {
      workflow_run_id: "wf-composed",
      maxWorkflowSiblingsPerWorker: 1,
      providerSeatNames: ["claude-a", "claude-b"],
      maxProviderInFlight: 2,
    }),
  ).toBe(true);
  expect(
    writer.claimDispatch("wf-c", "worker-3", {
      workflow_run_id: "wf-composed",
      maxWorkflowSiblingsPerWorker: 1,
      providerSeatNames: ["claude-a", "claude-b"],
      maxProviderInFlight: 2,
    }),
  ).toBe(false);
});

test("claimDispatch() without provider opts preserves existing claim behavior", () => {
  createApprovedHandoff("unrelated-provider-running", { to: "claude-a" });
  createApprovedHandoff("no-provider-opts", { to: "claude-b" });
  expect(writer.claimDispatch("unrelated-provider-running", "worker-1")).toBe(true);

  expect(writer.claimDispatch("no-provider-opts", "worker-2")).toBe(true);
});

test("claimDispatch() counts resolved_at dispatched rows toward provider in-flight cap", () => {
  createApprovedHandoff("resolved-running", {
    to: "claude-a",
    resolved_at: "2026-05-11T00:00:01Z",
  });
  createApprovedHandoff("resolved-next", { to: "claude-b" });

  expect(
    writer.claimDispatch("resolved-running", "worker-1", {
      providerSeatNames: ["claude-a", "claude-b"],
      maxProviderInFlight: 1,
    }),
  ).toBe(true);
  expect(
    writer.claimDispatch("resolved-next", "worker-2", {
      providerSeatNames: ["claude-a", "claude-b"],
      maxProviderInFlight: 1,
    }),
  ).toBe(false);
});

test("createApproved() persists workflow_run_id and max_dispatch_attempts", () => {
  writer.createApproved({
    handoff_id: "h-create-approved-new-fields",
    ts: "2026-05-11T00:00:00Z",
    conversation_id: "c1",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    project_id: null,
    triggered_by_event_id: "e",
    resolved_by: "u",
    resolved_at: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
    workflow_run_id: "wf-123",
    max_dispatch_attempts: 5,
  });

  const row = db
    .query("SELECT workflow_run_id, max_dispatch_attempts FROM handoffs WHERE handoff_id=?")
    .get("h-create-approved-new-fields");
  expect(row.workflow_run_id).toBe("wf-123");
  expect(row.max_dispatch_attempts).toBe(5);
});

test("createApproved() emits permission_profile and caller_cwd on the handoff row", () => {
  const bus = new HandoffEventBus();
  const writer = new HandoffWriter({ db, events: bus });
  const seen: HandoffRow[] = [];
  bus.subscribe((row) => {
    seen.push(row);
  });

  writer.createApproved({
    handoff_id: "h-create-approved-profile-emit",
    ts: "2026-05-11T00:00:00Z",
    conversation_id: "c1",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    project_id: null,
    triggered_by_event_id: "e",
    resolved_by: "u",
    resolved_at: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
    permission_profile: "review_readonly",
    caller_cwd: "/repos/caller",
  });

  expect(seen).toHaveLength(1);
  expect(seen[0]?.handoff_id).toBe("h-create-approved-profile-emit");
  expect(seen[0]?.permission_profile).toBe("review_readonly");
  expect(seen[0]?.caller_cwd).toBe("/repos/caller");
});

test("createApproved() defaults max_dispatch_attempts to 3", () => {
  writer.createApproved({
    handoff_id: "h-create-approved-defaults",
    ts: "2026-05-11T00:00:00Z",
    conversation_id: "c1",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    project_id: null,
    triggered_by_event_id: "e",
    resolved_by: "u",
    resolved_at: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
  });

  const row = db
    .query("SELECT workflow_run_id, max_dispatch_attempts FROM handoffs WHERE handoff_id=?")
    .get("h-create-approved-defaults");
  expect(row.workflow_run_id).toBeNull();
  expect(row.max_dispatch_attempts).toBe(3);
});

test("markCompleted() transitions dispatched → completed", () => {
  writer.create({
    handoff_id: "h-6",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c",
    project_id: null,
    triggered_by_event_id: "e",
  });
  writer.approve("h-6", { resolved_by: "u", resolved_at: "t" });
  writer.claimDispatch("h-6", "worker-1");
  writer.markCompleted("h-6", { ts: "done-ts" });
  const row = db
    .query<
      { status: string; resolved_at: string | null },
      [string]
    >("SELECT status, resolved_at FROM handoffs WHERE handoff_id=?")
    .get("h-6");
  expect(row?.status).toBe("completed");
  expect(row?.resolved_at).toBe("done-ts");
});

test("markCompleted() refuses cancel-requested dispatched handoffs", () => {
  writer.create({
    handoff_id: "h-cancel-complete",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c-cancel",
    project_id: null,
    triggered_by_event_id: "e",
  });
  writer.approve("h-cancel-complete", { resolved_by: "u", resolved_at: "t" });
  writer.claimDispatch("h-cancel-complete", "worker-1");
  writer.requestCancellation("c-cancel", "cancel-ts");

  expect(writer.markCompleted("h-cancel-complete", { ts: "done-ts" })).toBe(false);
  const row = db
    .query<
      { status: string; resolved_at: string | null },
      [string]
    >("SELECT status, resolved_at FROM handoffs WHERE handoff_id=?")
    .get("h-cancel-complete");
  expect(row?.status).toBe("dispatched");
  expect(row?.resolved_at).toBe("t");
});

test("requestCancellation does not stamp terminal handoffs", () => {
  writer.create({
    handoff_id: "h-cancel-expired",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c-terminal-cancel",
    project_id: null,
    triggered_by_event_id: "e-expired",
  });
  writer.approve("h-cancel-expired", { resolved_by: "u", resolved_at: "t" });
  writer.claimDispatch("h-cancel-expired", "worker-1");
  writer.expireDispatchedIdle("h-cancel-expired", {
    ts: "expired-ts",
    reason: "expired by sweeper after 1800000ms in dispatched",
    activitySinceIso: "recent-event-cutoff",
  });
  writer.create({
    handoff_id: "h-cancel-dispatched",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c-terminal-cancel",
    project_id: null,
    triggered_by_event_id: "e-dispatched",
  });
  writer.approve("h-cancel-dispatched", { resolved_by: "u", resolved_at: "t" });
  writer.claimDispatch("h-cancel-dispatched", "worker-2");

  expect(writer.requestCancellation("c-terminal-cancel", "cancel-ts")).toBe(true);
  const rows = db
    .query<
      { handoff_id: string; cancel_requested_at: string | null },
      []
    >("SELECT handoff_id, cancel_requested_at FROM handoffs ORDER BY handoff_id")
    .all();
  expect(rows).toEqual([
    { handoff_id: "h-cancel-dispatched", cancel_requested_at: "cancel-ts" },
    { handoff_id: "h-cancel-expired", cancel_requested_at: null },
  ]);
});

test("markCompleted() enforces expected_worker_id when provided", () => {
  writer.create({
    handoff_id: "h-cas-complete",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c-cas",
    project_id: null,
    triggered_by_event_id: "e",
  });
  writer.approve("h-cas-complete", { resolved_by: "u", resolved_at: "t" });
  writer.claimDispatch("h-cas-complete", "worker-B");

  // Wrong worker loses CAS
  expect(writer.markCompleted("h-cas-complete", { expected_worker_id: "worker-A" })).toBe(false);
  let row = db
    .query<
      { status: string; worker_id: string | null },
      [string]
    >("SELECT status, worker_id FROM handoffs WHERE handoff_id=?")
    .get("h-cas-complete");
  expect(row?.status).toBe("dispatched");
  expect(row?.worker_id).toBe("worker-B");

  // Correct worker wins CAS
  expect(writer.markCompleted("h-cas-complete", { expected_worker_id: "worker-B" })).toBe(true);
  row = db
    .query<
      { status: string; worker_id: string | null },
      [string]
    >("SELECT status, worker_id FROM handoffs WHERE handoff_id=?")
    .get("h-cas-complete");
  expect(row?.status).toBe("completed");
});

test("reject() stores reason and does NOT emit event", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const bus = new HandoffEventBus();
  const writer = new HandoffWriter({ db, events: bus });
  writer.create({
    handoff_id: "h-reject",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c",
    project_id: null,
    triggered_by_event_id: "e",
  });

  const seen: string[] = [];
  bus.subscribe((row) => seen.push(`${row.handoff_id}:${row.status}`));

  writer.reject("h-reject", { resolved_by: "user", resolved_at: "t2", reason: "unsupported" });
  const row = db
    .query<
      { status: string; resolution_reason: string | null },
      [string]
    >("SELECT status, resolution_reason FROM handoffs WHERE handoff_id=?")
    .get("h-reject");
  expect(row?.status).toBe("rejected");
  expect(row?.resolution_reason).toBe("unsupported");
  expect(seen).not.toContain("h-reject:rejected");
});

test("markFailed() transitions non-terminal → failed, records reason and does NOT emit event", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const bus = new HandoffEventBus();
  const writer = new HandoffWriter({ db, events: bus });

  const seen: string[] = [];
  bus.subscribe((row) => seen.push(`${row.handoff_id}:${row.status}`));

  // Test from pending
  writer.create({
    handoff_id: "h-fail-1",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c",
    project_id: null,
    triggered_by_event_id: "e",
  });
  expect(writer.markFailed("h-fail-1", { reason: "timeout" })).toBe(true);
  const row1 = db
    .query<
      { status: string; resolution_reason: string | null },
      [string]
    >("SELECT status, resolution_reason FROM handoffs WHERE handoff_id=?")
    .get("h-fail-1");
  expect(row1?.status).toBe("failed");
  expect(row1?.resolution_reason).toBe("timeout");
  expect(seen).not.toContain("h-fail-1:failed");

  // Test from dispatched
  writer.create({
    handoff_id: "h-fail-2",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c",
    project_id: null,
    triggered_by_event_id: "e",
  });
  writer.approve("h-fail-2", { resolved_by: "u", resolved_at: "t" });
  writer.claimDispatch("h-fail-2");
  expect(writer.markFailed("h-fail-2", { reason: "crash" })).toBe(true);
  const row2 = db
    .query<
      { status: string; resolution_reason: string | null },
      [string]
    >("SELECT status, resolution_reason FROM handoffs WHERE handoff_id=?")
    .get("h-fail-2");
  expect(row2?.status).toBe("failed");
  expect(seen).not.toContain("h-fail-2:failed");
});

test("markFailed() refuses to transition terminal status", () => {
  writer.create({
    handoff_id: "h-fail-term",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c",
    project_id: null,
    triggered_by_event_id: "e",
  });
  writer.approve("h-fail-term", { resolved_by: "u", resolved_at: "t" });
  writer.claimDispatch("h-fail-term");
  writer.markCompleted("h-fail-term");

  expect(writer.markFailed("h-fail-term", { reason: "too late" })).toBe(false);
  const row = db
    .query<{ status: string }, [string]>("SELECT status FROM handoffs WHERE handoff_id=?")
    .get("h-fail-term");
  expect(row?.status).toBe("completed");

  // Test from rejected
  writer.create({
    handoff_id: "h-fail-rejected",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c",
    project_id: null,
    triggered_by_event_id: "e",
  });
  writer.reject("h-fail-rejected", { resolved_by: "u", resolved_at: "t" });
  expect(writer.markFailed("h-fail-rejected", { reason: "fail after reject" })).toBe(false);

  // Test from failed (already failed)
  writer.create({
    handoff_id: "h-fail-failed",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c",
    project_id: null,
    triggered_by_event_id: "e",
  });
  writer.markFailed("h-fail-failed", { reason: "first" });
  expect(writer.markFailed("h-fail-failed", { reason: "second" })).toBe(false);
});

test("markFailed() enforces expected_worker_id when provided", () => {
  writer.create({
    handoff_id: "h-cas-failed",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c-cas",
    project_id: null,
    triggered_by_event_id: "e",
  });
  writer.approve("h-cas-failed", { resolved_by: "u", resolved_at: "t" });
  writer.claimDispatch("h-cas-failed", "worker-B");

  // Wrong worker loses CAS
  expect(
    writer.markFailed("h-cas-failed", { reason: "fail", expected_worker_id: "worker-A" }),
  ).toBe(false);
  let row = db
    .query<
      { status: string; worker_id: string | null },
      [string]
    >("SELECT status, worker_id FROM handoffs WHERE handoff_id=?")
    .get("h-cas-failed");
  expect(row?.status).toBe("dispatched");
  expect(row?.worker_id).toBe("worker-B");

  // Correct worker wins CAS
  expect(
    writer.markFailed("h-cas-failed", { reason: "fail", expected_worker_id: "worker-B" }),
  ).toBe(true);
  row = db
    .query<
      { status: string; worker_id: string | null },
      [string]
    >("SELECT status, worker_id FROM handoffs WHERE handoff_id=?")
    .get("h-cas-failed");
  expect(row?.status).toBe("failed");
});

test("HandoffWriter.approve emits a handoff-events event when bus is provided", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const bus = new HandoffEventBus();
  const writer = new HandoffWriter({ db, events: bus });
  writer.create({
    handoff_id: "h1",
    ts: "2026-04-26T00:00:00Z",
    conversation_id: "c1",
    from: "a",
    to: "b",
    message: "m",
    triggered_by_event_id: "e",
  });

  const seen: string[] = [];
  bus.subscribe((row) => seen.push(`${row.handoff_id}:${row.status}`));

  writer.approve("h1", { resolved_by: "u", resolved_at: "2026-04-26T00:00:01Z" });
  expect(seen).toContain("h1:approved");
});

test("HandoffWriter.approve emits redirected status when redirect_to set", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const bus = new HandoffEventBus();
  const writer = new HandoffWriter({ db, events: bus });
  writer.create({
    handoff_id: "h1",
    ts: "2026-04-26T00:00:00Z",
    conversation_id: "c1",
    from: "a",
    to: "b",
    message: "m",
    triggered_by_event_id: "e",
  });

  const seen: string[] = [];
  bus.subscribe((row) => seen.push(`${row.handoff_id}:${row.status}`));

  writer.approve("h1", {
    resolved_by: "u",
    resolved_at: "2026-04-26T00:00:01Z",
    redirect_to: "gemini",
  });
  expect(seen).toContain("h1:redirected");
});

test("createApproved() persists long-lived dispatch identity fields when supplied", () => {
  writer.createApproved({
    handoff_id: "h-long-lived",
    ts: "2026-05-11T00:00:00Z",
    project_id: null,
    conversation_id: "conv-long-lived",
    from: "user",
    to: "codex",
    to_role: null,
    message: "tick",
    triggered_by_event_id: "evt-long-lived",
    resolved_by: "chain-start",
    resolved_at: null,
    chain_max_hops: 1,
    chain_trust_mode: "all",
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
    branch_base: null,
    dispatch_kind: "long_lived_tick",
    long_lived_agent_id: "agent-1",
    long_lived_tick_id: "tick-1",
  });

  const row = db
    .query<
      {
        dispatch_kind: string | null;
        long_lived_agent_id: string | null;
        long_lived_tick_id: string | null;
      },
      [string]
    >(
      "SELECT dispatch_kind, long_lived_agent_id, long_lived_tick_id FROM handoffs WHERE handoff_id=?",
    )
    .get("h-long-lived");
  expect(row?.dispatch_kind).toBe("long_lived_tick");
  expect(row?.long_lived_agent_id).toBe("agent-1");
  expect(row?.long_lived_tick_id).toBe("tick-1");
});

test("createApproved() defaults long-lived dispatch identity fields to null when omitted", () => {
  writer.createApproved({
    handoff_id: "h-normal",
    ts: "2026-05-11T00:00:00Z",
    project_id: null,
    conversation_id: "conv-normal",
    from: "user",
    to: "codex",
    to_role: null,
    message: "normal dispatch",
    triggered_by_event_id: "evt-normal",
    resolved_by: "chain-start",
    resolved_at: null,
    chain_max_hops: 1,
    chain_trust_mode: "all",
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
    branch_base: null,
  });

  const row = db
    .query<
      {
        dispatch_kind: string | null;
        long_lived_agent_id: string | null;
        long_lived_tick_id: string | null;
      },
      [string]
    >(
      "SELECT dispatch_kind, long_lived_agent_id, long_lived_tick_id FROM handoffs WHERE handoff_id=?",
    )
    .get("h-normal");
  expect(row?.dispatch_kind).toBeNull();
  expect(row?.long_lived_agent_id).toBeNull();
  expect(row?.long_lived_tick_id).toBeNull();
});

test("create() self-roots a handoff with no parent", () => {
  writer.create({
    handoff_id: "r-self",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c",
    project_id: null,
    triggered_by_event_id: "e",
  });
  const row = db
    .query<
      { root_handoff_id: string | null },
      [string]
    >("SELECT root_handoff_id FROM handoffs WHERE handoff_id=?")
    .get("r-self");
  expect(row?.root_handoff_id).toBe("r-self");
});

test("create() inherits root_handoff_id from parent", () => {
  writer.create({
    handoff_id: "R",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c",
    project_id: null,
    triggered_by_event_id: "e",
  });
  writer.create({
    handoff_id: "C",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c",
    project_id: null,
    triggered_by_event_id: "e",
    parent_handoff_id: "R",
  });
  const row = db
    .query<
      { root_handoff_id: string | null },
      [string]
    >("SELECT root_handoff_id FROM handoffs WHERE handoff_id=?")
    .get("C");
  expect(row?.root_handoff_id).toBe("R");
});

test("create() falls back to parent id when parent root_handoff_id is null", () => {
  db.run(
    `INSERT INTO handoffs
       (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, parent_handoff_id, root_handoff_id)
     VALUES
       ('legacy-parent', 't', 'c', 'a', 'b', 'm', 'pending', NULL, NULL)`,
  );

  writer.create({
    handoff_id: "legacy-child",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c",
    project_id: null,
    triggered_by_event_id: "e",
    parent_handoff_id: "legacy-parent",
  });

  const row = db
    .query<
      { root_handoff_id: string | null },
      [string]
    >("SELECT root_handoff_id FROM handoffs WHERE handoff_id=?")
    .get("legacy-child");
  expect(row?.root_handoff_id).toBe("legacy-parent");
});

test("create() recursive inheritance — grandchild inherits grandparent root", () => {
  writer.create({
    handoff_id: "R",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c",
    project_id: null,
    triggered_by_event_id: "e",
  });
  writer.create({
    handoff_id: "C1",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c",
    project_id: null,
    triggered_by_event_id: "e",
    parent_handoff_id: "R",
  });
  writer.create({
    handoff_id: "G1",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c",
    project_id: null,
    triggered_by_event_id: "e",
    parent_handoff_id: "C1",
  });
  const row = db
    .query<
      { root_handoff_id: string | null },
      [string]
    >("SELECT root_handoff_id FROM handoffs WHERE handoff_id=?")
    .get("G1");
  expect(row?.root_handoff_id).toBe("R");
});

test("create() with orphaned parent self-roots and warns", () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    writer.create({
      handoff_id: "orphan-child",
      ts: "t",
      from: "a",
      to: "b",
      to_role: null,
      message: "m",
      conversation_id: "c",
      project_id: null,
      triggered_by_event_id: "e",
      parent_handoff_id: "nonexistent-parent-id",
    });
  } finally {
    console.warn = originalWarn;
  }
  const row = db
    .query<
      { root_handoff_id: string | null },
      [string]
    >("SELECT root_handoff_id FROM handoffs WHERE handoff_id=?")
    .get("orphan-child");
  expect(row?.root_handoff_id).toBe("orphan-child");
  expect(
    warnings.some((w) => w.includes("orphaned parent fallback") && w.includes("orphan-child")),
  ).toBe(true);
});

test("create() — distinct trees yield distinct root_handoff_ids", () => {
  writer.create({
    handoff_id: "R1",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c1",
    project_id: null,
    triggered_by_event_id: "e",
  });
  writer.create({
    handoff_id: "R1c",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c1",
    project_id: null,
    triggered_by_event_id: "e",
    parent_handoff_id: "R1",
  });
  writer.create({
    handoff_id: "R2",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c2",
    project_id: null,
    triggered_by_event_id: "e",
  });
  writer.create({
    handoff_id: "R2c",
    ts: "t",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    conversation_id: "c2",
    project_id: null,
    triggered_by_event_id: "e",
    parent_handoff_id: "R2",
  });

  const r1c = db
    .query<
      { root_handoff_id: string | null },
      [string]
    >("SELECT root_handoff_id FROM handoffs WHERE handoff_id=?")
    .get("R1c");
  const r2c = db
    .query<
      { root_handoff_id: string | null },
      [string]
    >("SELECT root_handoff_id FROM handoffs WHERE handoff_id=?")
    .get("R2c");
  expect(r1c?.root_handoff_id).toBe("R1");
  expect(r2c?.root_handoff_id).toBe("R2");
  expect(r1c?.root_handoff_id).not.toBe(r2c?.root_handoff_id);
});

test("HandoffWriter.createApproved inserts a handoff already in approved status with chain_* columns", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const bus = new HandoffEventBus();
  const writer = new HandoffWriter({ db, events: bus });
  const seen: HandoffRow[] = [];
  bus.subscribe((row) => seen.push(row));

  writer.createApproved({
    handoff_id: "h-cs",
    ts: "2026-04-26T00:00:00Z",
    project_id: "auth",
    conversation_id: "c1",
    from: "user",
    to: "planner",
    to_role: null,
    message: "go",
    triggered_by_event_id: "e-up",
    resolved_by: "chain-start",
    resolved_at: null,
    chain_max_hops: 5,
    chain_trust_mode: "all",
    chain_task_type: "implement_small",
  });

  const row = db
    .query<HandoffRow, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`)
    .get("h-cs");
  expect(row?.status).toBe("approved");
  expect(row?.from_agent).toBe("user");
  expect(row?.resolved_by).toBe("chain-start");
  expect(row?.resolved_at).toBeNull();
  expect(row?.chain_max_hops).toBe(5);
  expect(row?.chain_trust_mode).toBe("all");
  expect(row?.chain_task_type).toBe("implement_small");
  expect(seen.length).toBe(1);
  expect(seen[0].handoff_id).toBe("h-cs");
});

test("createApproved persists permission_profile inside the INSERT", () => {
  writer.createApproved({
    handoff_id: "h-prof-1",
    ts: "2026-05-11T00:00:00Z",
    conversation_id: "conv-prof",
    from: "a",
    to: "opencode-seat",
    to_role: null,
    message: "m",
    project_id: null,
    triggered_by_event_id: null,
    resolved_by: "u",
    resolved_at: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
    permission_profile: "review_readonly",
  });
  const row = db
    .query<
      { permission_profile: string | null },
      [string]
    >("SELECT permission_profile FROM handoffs WHERE handoff_id=?")
    .get("h-prof-1");
  expect(row?.permission_profile).toBe("review_readonly");
});

test("createApproved defaults permission_profile to null", () => {
  createApprovedHandoff("h-prof-null", { to: "seat-a" });
  const row = db
    .query<
      { permission_profile: string | null },
      [string]
    >("SELECT permission_profile FROM handoffs WHERE handoff_id=?")
    .get("h-prof-null");
  expect(row?.permission_profile).toBeNull();
});

test("create persists permission_profile on pending rows", () => {
  writer.create({
    handoff_id: "h-prof-pending",
    ts: "2026-05-11T00:00:00Z",
    conversation_id: "conv-pending",
    from: "a",
    to: "devin-seat",
    to_role: null,
    message: "m",
    triggered_by_event_id: "evt-1",
    permission_profile: "review_readonly",
  });
  const row = db
    .query<
      { permission_profile: string | null },
      [string]
    >("SELECT permission_profile FROM handoffs WHERE handoff_id=?")
    .get("h-prof-pending");
  expect(row?.permission_profile).toBe("review_readonly");
});
