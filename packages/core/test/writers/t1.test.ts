import { loadSqliteVec, migrate } from "@src/index.js";
import { TestEmbedder } from "@src/testing/index.js";
import { T1Rollup } from "@src/writers/t1.js";
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});

function seed(sessionId: string, n: number, lane = "local", origin: string | null = null): void {
  for (let i = 0; i < n; i++) {
    db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id,
        session_id, event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
        request_id, payload_json, payload_summary, origin)
       VALUES(?, ?, ?, 'mcp', null, 'p1', 'u', 'm', ?, 'agent-tool-use', ?, null, null, null, null, null, null, null, '{}', ?, ?)`,
      [
        `e-${sessionId}-${String(i)}`,
        `2026-04-23T12:0${String(i)}:00Z`,
        `2026-04-23T12:0${String(i)}:00Z`,
        sessionId,
        lane,
        `event ${String(i)}`,
        origin,
      ],
    );
  }
}

test("rollupSession produces a rollup + vec row with correct counts", async () => {
  seed("s1", 3);
  const roll = new T1Rollup({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-23T12:30:00Z"),
    uuid: (): string => "rollup-1",
  });

  const written = await roll.rollupSession("s1");
  expect(written).not.toBeNull();
  const row = db
    .query<
      { n_events: number; lane_breakdown_json: string },
      [string]
    >("SELECT n_events, lane_breakdown_json FROM t1_rollups WHERE rollup_id=?")
    .get("rollup-1")!;
  expect(row.n_events).toBe(3);
  expect(JSON.parse(row.lane_breakdown_json)).toEqual({ local: 3 });

  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM t1_vec").get()!.c).toBe(1);
});

test("rollupSession returns null if session has zero events", async () => {
  const roll = new T1Rollup({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-23T12:30:00Z"),
    uuid: (): string => "r",
  });

  expect(await roll.rollupSession("nonexistent")).toBeNull();
});

test("rollupSession is idempotent — re-running for same session is a no-op", async () => {
  seed("s1", 2);
  const roll = new T1Rollup({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-23T12:30:00Z"),
    uuid: ((): (() => string) => {
      let i = 0;
      return (): string => `r-${String(++i)}`;
    })(),
  });

  await roll.rollupSession("s1");
  const second = await roll.rollupSession("s1");
  expect(second).toBeNull();
  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM t1_rollups").get()!.c).toBe(1);
});

function appendEvent(sessionId: string, i: number, lane = "cloud"): void {
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id,
      session_id, event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
      request_id, payload_json, payload_summary)
     VALUES(?, ?, ?, 'mcp', null, 'p1', 'u', 'm', ?, 'agent-tool-use', ?, null, null, null, null, null, null, null, '{}', ?)`,
    [
      `e-${sessionId}-${String(i)}`,
      `2026-04-23T12:0${String(i)}:00Z`,
      `2026-04-23T12:0${String(i)}:00Z`,
      sessionId,
      lane,
      `event ${String(i)}`,
    ],
  );
}

test("rollupSession rerolls append-only by default when new events exist", async () => {
  seed("s_append", 2);
  const roll = new T1Rollup({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-23T12:30:00Z"),
    uuid: (): string => "r_append",
  });

  await roll.rollupSession("s_append");

  appendEvent("s_append", 2, "cloud"); // Add one more event
  const written = await roll.rollupSession("s_append");
  expect(written).toBe("r_append");

  const row = db
    .query<
      { n_events: number; lane_breakdown_json: string },
      [string]
    >("SELECT n_events, lane_breakdown_json FROM t1_rollups WHERE session_id=?")
    .get("s_append")!;
  expect(row.n_events).toBe(3);
  expect(JSON.parse(row.lane_breakdown_json)).toEqual({ local: 2, cloud: 1 });
});

function appendEventWithType(
  sessionId: string,
  i: number,
  eventType: string,
  payloadSummary: string,
  lane = "local",
): void {
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id,
      session_id, event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
      request_id, payload_json, payload_summary)
     VALUES(?, ?, ?, 'mcp', null, 'p1', 'u', 'm', ?, ?, ?, null, null, null, null, null, null, null, '{}', ?)`,
    [
      `e-${sessionId}-${String(i)}`,
      `2026-04-23T12:0${String(i)}:00Z`,
      `2026-04-23T12:0${String(i)}:00Z`,
      sessionId,
      eventType,
      lane,
      payloadSummary,
    ],
  );
}

test("rollupSession appends after t0 pruning when a newer event arrives", async () => {
  seed("s_prune", 3);
  const roll = new T1Rollup({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-23T12:30:00Z"),
    uuid: (): string => "r_prune",
  });

  await roll.rollupSession("s_prune");
  const before = db
    .query<
      { n_events: number; ended_at: string },
      [string]
    >("SELECT n_events, ended_at FROM t1_rollups WHERE session_id=?")
    .get("s_prune")!;
  expect(before.n_events).toBe(3);

  // Simulate t0 pruning: drop two of the three source events. After this,
  // the surviving rows.length (1) is below the stored n_events (3), and the
  // old count-based guard would permanently block any future append.
  db.run("DELETE FROM t0_events WHERE event_id IN ('e-s_prune-0','e-s_prune-1')");

  // A new event arrives with a ts strictly after the stored ended_at.
  appendEvent("s_prune", 4, "cloud");

  const written = await roll.rollupSession("s_prune");
  expect(written).toBe("r_prune");

  const after = db
    .query<
      { n_events: number; ended_at: string; lane_breakdown_json: string },
      [string]
    >("SELECT n_events, ended_at, lane_breakdown_json FROM t1_rollups WHERE session_id=?")
    .get("s_prune")!;
  // Rollup is recomputed from currently-visible t0 rows: 1 surviving + 1 new.
  expect(after.n_events).toBe(2);
  expect(JSON.parse(after.lane_breakdown_json)).toEqual({ local: 1, cloud: 1 });
  // ended_at advanced to the new event's ts.
  expect(after.ended_at > before.ended_at).toBe(true);
});

test("rollupSession append branch re-embeds t1_vec when last_response_excerpt changes", async () => {
  appendEventWithType("s_embed", 0, "agent-prompt", "the first prompt");
  appendEventWithType("s_embed", 1, "agent-response", "first response text");

  const roll = new T1Rollup({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-23T12:30:00Z"),
    uuid: (): string => "r_embed",
  });

  await roll.rollupSession("s_embed");

  const rowidRow = db
    .query<{ rowid: number }, [string]>("SELECT rowid FROM t1_rollups WHERE rollup_id=?")
    .get("r_embed")!;
  const before = db
    .query<{ embedding: Uint8Array }, [number]>("SELECT embedding FROM t1_vec WHERE rowid=?")
    .get(rowidRow.rowid)!;
  const beforeBuf = Buffer.from(before.embedding);

  // Append a new response — the appended payload_summary changes embedText.
  appendEventWithType("s_embed", 2, "agent-response", "completely different second response");
  const written = await roll.rollupSession("s_embed");
  expect(written).toBe("r_embed");

  const updated = db
    .query<
      { last_response_excerpt: string | null },
      [string]
    >("SELECT last_response_excerpt FROM t1_rollups WHERE rollup_id=?")
    .get("r_embed")!;
  expect(updated.last_response_excerpt).toBe("completely different second response");

  const after = db
    .query<{ embedding: Uint8Array }, [number]>("SELECT embedding FROM t1_vec WHERE rowid=?")
    .get(rowidRow.rowid)!;
  const afterBuf = Buffer.from(after.embedding);

  // The embedding must reflect the updated text. If the append branch leaves
  // t1_vec stale, these bytes are identical and recall fuses against a vector
  // that no longer matches the rollup body.
  expect(afterBuf.equals(beforeBuf)).toBe(false);

  // Exactly one t1_vec row for this rollup — the row was replaced, not duplicated.
  const vecCount = db
    .query<{ c: number }, [number]>("SELECT COUNT(*) c FROM t1_vec WHERE rowid=?")
    .get(rowidRow.rowid)!;
  expect(vecCount.c).toBe(1);
});

test("rollupSession fully overwrites when overwriteOnReroll is true", async () => {
  seed("s_over", 2);
  let idx = 0;
  const roll = new T1Rollup({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-23T12:30:00Z"),
    uuid: (): string => `r_over_${String(++idx)}`,
    overwriteOnReroll: true,
  });

  await roll.rollupSession("s_over");

  appendEvent("s_over", 2, "cloud"); // Add one more
  const written = await roll.rollupSession("s_over");
  expect(written).toBe("r_over_2"); // New ID

  const row = db
    .query<
      { rollup_id: string; n_events: number },
      [string]
    >("SELECT rollup_id, n_events FROM t1_rollups WHERE session_id=?")
    .get("s_over")!;
  expect(row.rollup_id).toBe("r_over_2");
  expect(row.n_events).toBe(3);
});

test("rollupSession picks maestro over dispatch over unknown when origins are mixed", async () => {
  // 1 maestro + 2 dispatch — winner is maestro.
  seed("s_mix", 1, "local", "maestro");
  // Append two more rows with dispatch origin to the same session.
  for (let i = 1; i < 3; i++) {
    db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id,
        session_id, event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
        request_id, payload_json, payload_summary, origin)
       VALUES(?, ?, ?, 'mcp', null, 'p1', 'u', 'm', 's_mix', 'agent-tool-use', 'local', null, null, null, null, null, null, null, '{}', ?, 'dispatch')`,
      [
        `e-mix-${String(i)}`,
        `2026-04-23T13:0${String(i)}:00Z`,
        `2026-04-23T13:0${String(i)}:00Z`,
        `event ${String(i)}`,
      ],
    );
  }

  const roll = new T1Rollup({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-23T13:30:00Z"),
    uuid: (): string => "r_mix",
  });
  await roll.rollupSession("s_mix");

  const row = db
    .query<{ origin: string | null }, [string]>("SELECT origin FROM t1_rollups WHERE session_id=?")
    .get("s_mix")!;
  expect(row.origin).toBe("maestro");
});

test("rollupSession leaves origin NULL when all source events have NULL origin (legacy)", async () => {
  seed("s_legacy", 2, "local", null);
  const roll = new T1Rollup({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-23T13:30:00Z"),
    uuid: (): string => "r_legacy",
  });
  await roll.rollupSession("s_legacy");
  const row = db
    .query<{ origin: string | null }, [string]>("SELECT origin FROM t1_rollups WHERE session_id=?")
    .get("s_legacy")!;
  expect(row.origin).toBeNull();
});

test("rollupSession dispatch beats unknown", async () => {
  seed("s_du", 1, "local", "dispatch");
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id,
      session_id, event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
      request_id, payload_json, payload_summary, origin)
     VALUES('e-du-1', '2026-04-23T13:01:00Z', '2026-04-23T13:01:00Z', 'mcp', null, 'p1', 'u', 'm', 's_du', 'agent-tool-use', 'local', null, null, null, null, null, null, null, '{}', 'event 1', 'unknown')`,
  );
  const roll = new T1Rollup({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-23T13:30:00Z"),
    uuid: (): string => "r_du",
  });
  await roll.rollupSession("s_du");
  const row = db
    .query<{ origin: string | null }, [string]>("SELECT origin FROM t1_rollups WHERE session_id=?")
    .get("s_du")!;
  expect(row.origin).toBe("dispatch");
});

test("rollupSession is concurrency-safe — racing calls fold to one row", async () => {
  seed("sR", 3);
  let uuidIdx = 0;
  const roll = new T1Rollup({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-23T12:30:00Z"),
    uuid: (): string => `race-${String(++uuidIdx)}`,
  });

  const [a, b] = await Promise.all([roll.rollupSession("sR"), roll.rollupSession("sR")]);
  // One call did the work, the other returned null. We don't care which.
  const winners = [a, b].filter((x): x is string => typeof x === "string");
  const losers = [a, b].filter((x) => x === null);
  expect(winners.length).toBe(1);
  expect(losers.length).toBe(1);
  const count = db
    .query<{ c: number }, [string]>("SELECT COUNT(*) c FROM t1_rollups WHERE session_id=?")
    .get("sR");
  expect(count?.c).toBe(1);
});
