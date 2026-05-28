import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

function seedDispatchMemory(db: Database, handoffId: string, memoryId: string): void {
  db.run(
    `INSERT INTO dispatch_events(handoff_id, worker_id, source, kind, ts, meta_json)
     VALUES (?, NULL, 'worker', 'memory_recall_injected', '2026-05-17T12:00:00.000Z', ?)`,
    [handoffId, JSON.stringify({ memory_id: memoryId })],
  );
}

test("authorize route accepts manual_override and writes verification rows", async () => {
  const ctx = setup();
  try {
    seedMemory(ctx.db, "m-1", "2026-05-17T11:00:00.000Z");
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
    const body = (await res.json()) as { ok: boolean; events_written: number };
    expect(body.ok).toBe(true);
    expect(body.events_written).toBe(0);
  } finally {
    ctx.stop();
  }
});

test("authorize route writes one row per injected memory", async () => {
  const ctx = setup();
  try {
    seedMemory(ctx.db, "m-1", "2026-05-17T11:00:00.000Z");
    seedMemory(ctx.db, "m-2", "2026-05-17T11:05:00.000Z");
    ctx.db.run(
      `INSERT INTO dispatch_events(handoff_id, worker_id, source, kind, ts, meta_json)
       VALUES (?, NULL, 'worker', 'memory_recall_injected', ?, ?)`,
      ["h-auth", "2026-05-17T12:00:00.000Z", JSON.stringify({ memory_ids: ["m-1", "m-2"] })],
    );

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
    const body = (await res.json()) as { ok: boolean; events_written: number };
    expect(body.ok).toBe(true);
    expect(body.events_written).toBe(2);

    const rows = ctx.db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM t2_memory_verification_events")
      .get();
    expect(rows?.c).toBe(2);
  } finally {
    ctx.stop();
  }
});

test("authorize route is idempotent for the same memory basis", async () => {
  const ctx = setup();
  try {
    seedMemory(ctx.db, "m-1", "2026-05-17T11:00:00.000Z");
    seedDispatchMemory(ctx.db, "h-auth", "m-1");

    const payload = {
      handoff_id: "h-auth",
      verdict: "passed",
      authorized_by_handoff: "h-auth",
      basis: { kind: "manual_override", reason: "approved", authorized_by: "lead" },
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

test("authorize route returns zero writes when the handoff has no injected memories", async () => {
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
    const body = (await res.json()) as { ok: boolean; events_written: number };
    expect(body.ok).toBe(true);
    expect(body.events_written).toBe(0);
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
