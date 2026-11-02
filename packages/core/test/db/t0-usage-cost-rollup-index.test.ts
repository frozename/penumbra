import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";

import { applySchema } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { recentCost } from "@src/readers/cost.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // A sibling test may have already loaded SQLite.
  }
}

const ROLLUP_INDEX = "t0_events_usage_cost_rollup";

// The five payload expressions as they appear in the covering index. SQLite
// only treats the index as covering when the query's expressions match these
// verbatim (parsed-expression equality), so every payload read stays guarded
// by json_valid — the index build must also survive malformed rows.
const HANDOFF_KEY_EXPR = `CASE WHEN json_valid(payload_json) THEN COALESCE(json_extract(payload_json, '$.handoff_id'), event_id) ELSE event_id END`;
const USED_EXPR = `CASE WHEN json_valid(payload_json) THEN CAST(json_extract(payload_json, '$.used') AS INTEGER) END`;
const INPUT_EXPR = `CASE WHEN json_valid(payload_json) THEN COALESCE(CAST(json_extract(payload_json, '$.tokens_input') AS INTEGER), tokens_in, 0) ELSE COALESCE(tokens_in, 0) END`;
const CACHE_READ_EXPR = `CASE WHEN json_valid(payload_json) THEN COALESCE(CAST(json_extract(payload_json, '$.tokens_cache_read') AS INTEGER), 0) ELSE 0 END`;
const CACHE_WRITE_EXPR = `CASE WHEN json_valid(payload_json) THEN COALESCE(CAST(json_extract(payload_json, '$.tokens_cache_write') AS INTEGER), 0) ELSE 0 END`;
const GUARDED_FRAGMENTS = [
  HANDOFF_KEY_EXPR,
  USED_EXPR,
  INPUT_EXPR,
  CACHE_READ_EXPR,
  CACHE_WRITE_EXPR,
];

// The aggregation text the shipped reader must prepare. The group key is
// wrapped in MAX() because SQLite does not treat a bare expression in an
// aggregate query's result list as index-covered; the key is constant within
// each group, so MAX(group_key) = group_key.
const COVERING_ROLLUP_SQL = `
    SELECT
      MAX(${HANDOFF_KEY_EXPR}) AS handoff_key,
      provider,
      model,
      MAX(cost_usd) AS handoff_cost_usd,
      MAX(CASE WHEN lane = 'cloud' THEN cost_usd END) AS handoff_cost_usd_billed,
      MAX(CASE WHEN lane = 'cli-subscription' THEN cost_usd END) AS handoff_cost_usd_synth,
      MAX(${USED_EXPR}) AS handoff_tokens,
      MAX(${INPUT_EXPR}) AS handoff_input_tokens,
      MAX(${CACHE_READ_EXPR}) AS handoff_tokens_cache_read,
      MAX(${CACHE_WRITE_EXPR}) AS handoff_tokens_cache_write
    FROM t0_events
    WHERE event_type = 'usage-update'
      AND ts >= ?
      AND (? IS NULL OR project_id = ?)
    GROUP BY
      ${HANDOFF_KEY_EXPR},
      provider,
      model
  `;

// Pre-change query text, frozen as the result-equivalence oracle.
const ORACLE_SQL = `
    SELECT
      COALESCE(json_extract(payload_json, '$.handoff_id'), event_id) AS handoff_key,
      provider,
      model,
      MAX(cost_usd) AS handoff_cost_usd,
      MAX(CASE WHEN lane = 'cloud' THEN cost_usd END) AS handoff_cost_usd_billed,
      MAX(CASE WHEN lane = 'cli-subscription' THEN cost_usd END) AS handoff_cost_usd_synth,
      MAX(CAST(json_extract(payload_json, '$.used') AS INTEGER)) AS handoff_tokens,
      MAX(COALESCE(CAST(json_extract(payload_json, '$.tokens_input') AS INTEGER), tokens_in, 0)) AS handoff_input_tokens,
      MAX(COALESCE(CAST(json_extract(payload_json, '$.tokens_cache_read') AS INTEGER), 0)) AS handoff_tokens_cache_read,
      MAX(COALESCE(CAST(json_extract(payload_json, '$.tokens_cache_write') AS INTEGER), 0)) AS handoff_tokens_cache_write
    FROM t0_events
    WHERE event_type = 'usage-update'
      AND ts >= ?
      AND (? IS NULL OR project_id = ?)
    GROUP BY handoff_key, provider, model
  `;

const SINCE = "2026-10-01T00:00:00.000Z";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function freshDb(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  return db;
}

function planDetails(db: Database, sql: string, params: (string | number | null)[]): string[] {
  return db
    .query<{ detail: string }, (string | number | null)[]>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail);
}

interface RollupRow {
  handoff_key: string;
  provider: string | null;
  model: string | null;
  handoff_cost_usd: number | null;
  handoff_cost_usd_billed: number | null;
  handoff_cost_usd_synth: number | null;
  handoff_tokens: number | null;
  handoff_input_tokens: number | null;
  handoff_tokens_cache_read: number | null;
  handoff_tokens_cache_write: number | null;
}

function runRollup(
  db: Database,
  sql: string,
  since: string,
  projectId: string | null,
): RollupRow[] {
  const rows = db.prepare(sql).all(since, projectId, projectId) as RollupRow[];
  const key = (r: RollupRow): string => `${r.handoff_key}${r.provider ?? ""}${r.model ?? ""}`;
  return rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function insertT0(
  db: Database,
  row: {
    event_id: string;
    ts: string;
    event_type?: string;
    lane?: string;
    provider?: string | null;
    model?: string | null;
    tokens_in?: number | null;
    cost_usd?: number | null;
    project_id?: string | null;
    payload_json: string;
  },
): void {
  db.prepare(
    `INSERT INTO t0_events (event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, model, tokens_in, cost_usd, project_id, payload_json)
     VALUES (?, ?, ?, 'agentchat', 'u', 'm', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.event_id,
    row.ts,
    row.ts,
    row.event_type ?? "usage-update",
    row.lane ?? "cloud",
    row.provider ?? null,
    row.model ?? null,
    row.tokens_in ?? null,
    row.cost_usd ?? null,
    row.project_id ?? null,
    row.payload_json,
  );
}

function seedRollupMatrix(db: Database): void {
  insertT0(db, {
    event_id: "e1",
    ts: "2026-10-05T01:00:00Z",
    provider: "anthropic",
    model: "claude",
    tokens_in: 100,
    cost_usd: 0.5,
    project_id: "pa",
    payload_json: JSON.stringify({
      handoff_id: "h1",
      used: 100,
      tokens_input: 100,
      tokens_cache_read: 40,
      tokens_cache_write: 5,
    }),
  });
  insertT0(db, {
    event_id: "e2",
    ts: "2026-10-05T02:00:00Z",
    provider: "anthropic",
    model: "claude",
    tokens_in: 150,
    cost_usd: 0.7,
    project_id: "pa",
    payload_json: JSON.stringify({ handoff_id: "h1", used: 150, tokens_cache_read: 80 }),
  });
  insertT0(db, {
    event_id: "e3",
    ts: "2026-10-05T03:00:00Z",
    lane: "cli-subscription",
    provider: "openai",
    model: "gpt",
    cost_usd: 0.3,
    project_id: "pa",
    payload_json: JSON.stringify({ handoff_id: "h2", used: 50, tokens_input: 20 }),
  });
  // No handoff_id in payload -> falls back to event_id as the group key.
  insertT0(db, {
    event_id: "e4",
    ts: "2026-10-05T04:00:00Z",
    provider: "anthropic",
    model: "haiku",
    cost_usd: 0.1,
    project_id: "pb",
    payload_json: JSON.stringify({ used: 10 }),
  });
  // Same handoff as e1/e2 but provider/model NULL -> a distinct group.
  insertT0(db, {
    event_id: "e5",
    ts: "2026-10-05T05:00:00Z",
    cost_usd: null,
    project_id: "pa",
    payload_json: JSON.stringify({ handoff_id: "h1", used: 5 }),
  });
  // Out of window.
  insertT0(db, {
    event_id: "e6",
    ts: "2025-01-01T00:00:00Z",
    provider: "anthropic",
    model: "claude",
    cost_usd: 9.9,
    project_id: "pa",
    payload_json: JSON.stringify({ handoff_id: "h-old", used: 10 }),
  });
  // Not a usage-update event even though the payload carries handoff_id.
  insertT0(db, {
    event_id: "e7",
    ts: "2026-10-05T06:00:00Z",
    event_type: "request",
    provider: "anthropic",
    model: "claude",
    cost_usd: 9.9,
    project_id: "pa",
    payload_json: JSON.stringify({ handoff_id: "h-no", used: 10 }),
  });
  // 'null' is valid JSON: json_extract yields NULL, so the group key falls back
  // to event_id exactly like a missing $.handoff_id.
  insertT0(db, {
    event_id: "e8",
    ts: "2026-10-05T07:00:00Z",
    provider: "anthropic",
    model: "claude",
    tokens_in: 7,
    cost_usd: 0.02,
    project_id: "pb",
    payload_json: "null",
  });
}

test("the cost rollup aggregation is fully covered by the rollup index", () => {
  const db = freshDb();
  for (const projectId of [null, "pa"]) {
    const details = planDetails(db, COVERING_ROLLUP_SQL, [SINCE, projectId, projectId]);
    expect(details).not.toContain("SCAN t0_events");
    expect(details.join(" ")).toContain(`USING COVERING INDEX ${ROLLUP_INDEX}`);
  }
});

test("the covering plan survives ANALYZE on a populated store", () => {
  const db = freshDb();
  seedRollupMatrix(db);
  const insert = db.prepare(
    `INSERT INTO t0_events (event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, model, payload_json)
     VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'usage-update', 'cloud', 'anthropic', 'claude', ?)`,
  );
  for (let i = 0; i < 200; i++) {
    insert.run(
      `bulk-${String(i)}`,
      `2026-10-05T08:${String(i % 60).padStart(2, "0")}:00Z`,
      "2026-10-05T08:00:00Z",
      `{"handoff_id":"h-bulk-${String(i % 7)}","used":${String(i)}}`,
    );
  }
  db.run("ANALYZE");
  for (const projectId of [null, "pa"]) {
    const details = planDetails(db, COVERING_ROLLUP_SQL, [SINCE, projectId, projectId]);
    expect(details).not.toContain("SCAN t0_events");
    expect(details.join(" ")).toContain(`USING COVERING INDEX ${ROLLUP_INDEX}`);
  }
});

test("covering rollup results equal the pre-change oracle", () => {
  const db = freshDb();
  seedRollupMatrix(db);
  for (const projectId of [null, "pa", "pb", "absent"]) {
    const oracle = runRollup(db, ORACLE_SQL, SINCE, projectId);
    const rolled = runRollup(db, COVERING_ROLLUP_SQL, SINCE, projectId);
    expect(rolled, `projectId=${String(projectId)}`).toEqual(oracle);
  }
});

test("recentCost totals over the rollup path match hand-computed expectations", () => {
  const db = freshDb();
  seedRollupMatrix(db);
  const out = recentCost(db, { since: SINCE }, () => new Date("2026-10-05T12:00:00Z"));
  // Per-(handoff, provider) groups take MAX(cost), then sum: (h1,anthropic)
  // max(0.5,0.7)=0.7, (h2,openai)=0.3, (e4,anthropic)=0.1, (e8,anthropic)=0.02,
  // (h1,null-provider) has null cost.
  expect(out.total_cost_usd).toBeCloseTo(1.12, 10);
  expect(out.handoff_count).toBe(5);
  expect(out.total_tokens_used).toBe(150 + 50 + 10 + 5);
  expect(out.total_cost_usd_billed).toBeCloseTo(0.7 + 0.1 + 0.02, 10);
  expect(out.total_cost_usd_synth).toBeCloseTo(0.3, 10);
});

test("malformed payloads group under event_id instead of aborting the read", () => {
  const db = freshDb();
  seedRollupMatrix(db);
  insertT0(db, {
    event_id: "e-mal",
    ts: "2026-10-05T09:00:00Z",
    provider: "anthropic",
    model: "claude",
    tokens_in: 3,
    cost_usd: 0.01,
    project_id: "pb",
    payload_json: "{",
  });
  // The oracle text aborts outright on malformed JSON; the guarded rewrite
  // keeps the event visible under its event_id with null aggregates.
  expect(() => runRollup(db, ORACLE_SQL, SINCE, null)).toThrow();
  const rolled = runRollup(db, COVERING_ROLLUP_SQL, SINCE, null);
  const mal = rolled.find((row) => row.handoff_key === "e-mal");
  expect(mal?.handoff_cost_usd).toBe(0.01);
  expect(mal?.handoff_tokens).toBeNull();
  expect(mal?.handoff_input_tokens).toBe(3);
});

test("the index builds over malformed payloads on re-apply", () => {
  const db = freshDb();
  db.run(`DROP INDEX IF EXISTS ${ROLLUP_INDEX}`);
  insertT0(db, {
    event_id: "e-mal",
    ts: "2026-10-05T09:00:00Z",
    payload_json: "{",
  });
  applySchema(db, { embeddingDim: 384 });
  const name = db
    .query<
      { name: string },
      [string]
    >("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(ROLLUP_INDEX)?.name;
  expect(name).toBe(ROLLUP_INDEX);
});

test("every guarded expression in the shipped query appears verbatim in the index", async () => {
  const db = freshDb();
  const indexSql = db
    .query<
      { sql: string },
      [string]
    >("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(ROLLUP_INDEX)?.sql;
  expect(indexSql).toBeDefined();
  const normalizedIndex = indexSql!.replaceAll(/\s+/g, " ");
  for (const fragment of GUARDED_FRAGMENTS) {
    expect(normalizedIndex).toContain(fragment.replaceAll(/\s+/g, " "));
  }

  const costSource = await Bun.file(resolve(import.meta.dir, "../../src/readers/cost.ts")).text();
  for (const fragment of GUARDED_FRAGMENTS) {
    expect(costSource.replaceAll(/\s+/g, " ")).toContain(fragment.replaceAll(/\s+/g, " "));
  }
  expect(costSource).toMatch(/\.prepare\(\s*PER_HANDOFF_COST_ROLLUP_SQL/);

  const { PER_HANDOFF_COST_ROLLUP_SQL } = await import("@src/readers/cost.js");
  expect(PER_HANDOFF_COST_ROLLUP_SQL.replaceAll(/\s+/g, " ")).toBe(
    COVERING_ROLLUP_SQL.replaceAll(/\s+/g, " "),
  );
});
