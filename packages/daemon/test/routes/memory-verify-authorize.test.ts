import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServices, loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { memoryVerifyAuthorizeRoute } from "../../src/routes/memory-verify.js";

function setup() {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const root = mkdtempSync(join(tmpdir(), "memory-verify-auth-"));
  const reviewsDir = join(root, ".penumbra", "reviews");
  mkdirSync(reviewsDir, { recursive: true });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: join(root, "storage"),
    reviewsDir,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    mainRepoDir: process.cwd(),
    worktreeRootDir: join(root, "worktrees"),
  });
  return {
    db,
    root,
    reviewsDir,
    services,
    stop: () => rmSync(root, { recursive: true, force: true }),
  };
}

function seedMemory(db: Database, memoryId: string, createdAt: string): void {
  db.run(
    `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, compressed_from, created_at, updated_at)
     VALUES (?, NULL, 'u1', 'fact', '[]', ?, ?, ?, ?, '{}', NULL, ?, ?)`,
    [memoryId, createdAt, createdAt, memoryId, `${memoryId} body`, createdAt, createdAt],
  );
}

function seedLaneClose(
  db: Database,
  laneId: string,
  recalledMemoryIds: string[],
  reviewerHandoff = "h-review",
): void {
  db.run(
    `INSERT INTO lane_ledger(
      lane_id, ts_opened, ts_closed, task_class, implementer_handoff, reviewer_handoff,
      gate_status, recalled_memory_ids, recalled_query, metadata_json
    ) VALUES (?, '2026-05-17T10:00:00.000Z', '2026-05-17T11:00:00.000Z', 'STANDARD',
      'h-impl', ?, 'passed', ?, NULL, '{}')`,
    [laneId, reviewerHandoff, JSON.stringify(recalledMemoryIds)],
  );
}

function seedHandoff(
  db: Database,
  handoffId: string,
  fromAgent: string,
  toAgent: string,
  taskType: string,
): void {
  db.run(
    `INSERT INTO handoffs(handoff_id, ts, conversation_id, from_agent, to_agent, message, status, chain_task_type)
     VALUES (?, '2026-05-17T12:00:00.000Z', ?, ?, ?, 'prompt', 'dispatched', ?)`,
    [handoffId, `c-${handoffId}`, fromAgent, toAgent, taskType],
  );
}

test("authorize route writes one row per lane_ledger recalled memory for lane_close basis", async () => {
  const ctx = setup();
  try {
    seedMemory(ctx.db, "m1", "2026-05-17T11:00:00.000Z");
    seedMemory(ctx.db, "m2", "2026-05-17T11:05:00.000Z");
    seedLaneClose(ctx.db, "L1", ["m1", "m2"], "h-review");

    const res = await memoryVerifyAuthorizeRoute(
      new Request("http://x/memory-verify/authorize", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-auth",
          verdict: "passed",
          authorized_by_handoff: "h-auth",
          basis: { kind: "lane_close", lane_id: "L1", reviewer_handoff: "h-review" },
        }),
      }),
      ctx.services,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; events_written: number };
    expect(body.ok).toBe(true);
    expect(body.events_written).toBe(2);

    const writtenRows = ctx.db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM t2_memory_verification_events")
      .get();
    expect(writtenRows?.c).toBe(2);

    const verifiedRows = ctx.db
      .query<{ c: number }, []>(
        `SELECT COUNT(*) AS c
         FROM t2_memories
         WHERE memory_id IN ('m1', 'm2') AND last_verified_at IS NOT NULL`,
      )
      .get();
    expect(verifiedRows?.c).toBe(2);
  } finally {
    ctx.stop();
  }
});

test("authorize route is idempotent for lane_close basis", async () => {
  const ctx = setup();
  try {
    seedMemory(ctx.db, "m1", "2026-05-17T11:00:00.000Z");
    seedLaneClose(ctx.db, "L1", ["m1"], "h-review");

    const payload = {
      handoff_id: "h-auth",
      verdict: "passed",
      authorized_by_handoff: "h-auth",
      basis: { kind: "lane_close", lane_id: "L1", reviewer_handoff: "h-review" },
    };

    const first = await memoryVerifyAuthorizeRoute(
      new Request("http://x/memory-verify/authorize", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
      ctx.services,
    );
    expect(first.status).toBe(200);
    expect(((await first.json()) as { events_written: number }).events_written).toBe(1);

    const second = await memoryVerifyAuthorizeRoute(
      new Request("http://x/memory-verify/authorize", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
      ctx.services,
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as { events_written: number }).events_written).toBe(0);

    const rows = ctx.db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM t2_memory_verification_events")
      .get();
    expect(rows?.c).toBe(1);
  } finally {
    ctx.stop();
  }
});

test("authorize route returns zero writes with reason for manual_override basis", async () => {
  const ctx = setup();
  try {
    const res = await memoryVerifyAuthorizeRoute(
      new Request("http://x/memory-verify/authorize", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-auth",
          verdict: "passed",
          authorized_by_handoff: "h-auth",
          basis: { kind: "manual_override", reason: "approved", authorized_by: "lead" },
        }),
      }),
      ctx.services,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      events_written: number;
      reason: string | undefined;
    };
    expect(body.ok).toBe(true);
    expect(body.events_written).toBe(0);
    expect(body.reason).toContain("manual_override");
  } finally {
    ctx.stop();
  }
});

test("authorize route rejects adversarial_review traversal", async () => {
  const ctx = setup();
  try {
    const res = await memoryVerifyAuthorizeRoute(
      new Request("http://x/memory-verify/authorize", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-auth",
          verdict: "passed",
          basis: {
            kind: "adversarial_review",
            synthesis_path: "../escape.md",
            synthesizer_handoff: "h-synth",
          },
        }),
      }),
      ctx.services,
    );
    expect(res.status).toBe(400);
  } finally {
    ctx.stop();
  }
});

test("authorize route returns zero writes with reason for dispatch_land basis", async () => {
  const ctx = setup();
  try {
    seedMemory(ctx.db, "m1", "2026-05-17T11:00:00.000Z");
    seedLaneClose(ctx.db, "L1", ["m1"], "h-review");
    seedHandoff(ctx.db, "h-review", "h-impl", "h-review", "review_adversarial");

    const res = await memoryVerifyAuthorizeRoute(
      new Request("http://x/memory-verify/authorize", {
        method: "POST",
        body: JSON.stringify({
          handoff_id: "h-auth",
          verdict: "passed",
          authorized_by_handoff: "h-auth",
          basis: {
            kind: "dispatch_land",
            merge_commit: "f128dd9",
            reviewer_handoff: "h-review",
          },
        }),
      }),
      ctx.services,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      events_written: number;
      reason: string | undefined;
    };
    expect(body.ok).toBe(true);
    expect(body.events_written).toBe(0);
    expect(body.reason).toContain("dispatch_land");
    expect(body.reason).toContain("lane_close");
  } finally {
    ctx.stop();
  }
});
