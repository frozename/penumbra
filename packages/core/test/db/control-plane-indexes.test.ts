import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { loadSqliteVec, migrate } from "@src/index.js";
import { TestEmbedder } from "@src/testing/index.js";
import { T2Promotion } from "@src/writers/t2.js";

let db: Database;
const names = [
  "t1_promotion_eligible_lookup",
  "t1_promotion_claim_lookup",
  "idx_dream_actions_phase_status",
  "idx_dispatch_events_activity_end_ts",
];
beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});
afterEach(() => {
  db.close();
});

test("fresh and existing databases gain the control-plane indexes idempotently", () => {
  const indexed = (): string[] =>
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((row) => row.name);
  for (const name of names) expect(indexed()).toContain(name);
  for (const name of names) db.run("DROP INDEX " + name);
  migrate(db, { embeddingDim: 384 });
  migrate(db, { embeddingDim: 384 });
  for (const name of names) expect(indexed().filter((n) => n === name)).toHaveLength(1);
});

test("eligibility preserves closed/open age, event floor, retry and terminal filters", () => {
  const seed = db.prepare(
    "INSERT INTO t1_rollups(rollup_id,user_id,session_id,started_at,ended_at,n_events,failed_promotion_attempts,t2_promoted_at,promotion_filtered_at)VALUES(?,'user',?,?,?,?,?,?,?)",
  );
  const old = "2026-01-01T00:00:00Z",
    recent = "2026-01-03T00:00:00Z";
  for (const [id, start, end, events, failures, promoted, filtered] of [
    ["closed", old, old, 5, 0, null, null],
    ["open", old, null, 6, 0, null, null],
    ["recent", recent, recent, 5, 0, null, null],
    ["short", old, old, 4, 0, null, null],
    ["failed", old, old, 5, 5, null, null],
    ["promoted", old, old, 5, 0, old, null],
    ["filtered", old, old, 5, 0, null, old],
  ] as const)
    seed.run(id, id, start, end, events, failures, promoted, filtered);
  const promotion = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date(recent),
    uuid: (): string => "unused",
    llm: (): Promise<[]> => Promise.resolve([]),
  });
  const select = (): string[] => promotion.detectEligibleRollups(24, new Date(recent)).sort();
  for (const name of names) db.run("DROP INDEX " + name);
  expect(select()).toEqual(["closed", "open"]);
  migrate(db, { embeddingDim: 384 });
  expect(select()).toEqual(["closed", "open"]);
  expect(promotion.detectEligibleRollups(24, new Date(recent), 4).sort()).toEqual([
    "closed",
    "open",
    "short",
  ]);
  const plan = db
    .query<{ detail: string }, [string, string, number, number]>(
      "EXPLAIN QUERY PLAN SELECT rollup_id FROM t1_rollups WHERE t2_promoted_at IS NULL AND promotion_filtered_at IS NULL AND (ended_at<? OR(ended_at IS NULL AND started_at<?))AND failed_promotion_attempts<? AND n_events>=?",
    )
    .all(recent, recent, 5, 5)
    .map((r) => r.detail)
    .join(" ");
  expect(plan).toContain("COVERING INDEX t1_promotion_eligible_lookup");
});

test("claim scan is covered and ordered without fetching wide rollup rows", () => {
  const plan = db
    .query<{ detail: string }, []>(
      "EXPLAIN QUERY PLAN SELECT rollup_id,project_id,promotion_retry_count FROM t1_rollups WHERE t2_promoted_at IS NULL AND claimed_at IS NULL AND promotion_filtered_at IS NULL AND promotion_unusable_excerpt_at IS NULL AND promotion_retry_exhausted_at IS NULL AND(promotion_retry_after IS NULL OR promotion_retry_after<=1000)AND(first_prompt_excerpt IS NULL OR first_prompt_excerpt NOT LIKE 'Implement %')AND user_id!='dispatcher' ORDER BY started_at LIMIT 2",
    )
    .all()
    .map((r) => r.detail)
    .join(" ");
  expect(plan).toContain("COVERING INDEX t1_promotion_claim_lookup");
  expect(plan).not.toContain("TEMP B-TREE");
});

test("queue counts and activity timestamp use small covering lookups", () => {
  const explain = (sql: string): string =>
    db
      .query<{ detail: string }, []>("EXPLAIN QUERY PLAN " + sql)
      .all()
      .map((r) => r.detail)
      .join(" ");
  expect(
    explain("SELECT COUNT(*)FROM dream_actions WHERE phase='P4'AND status='queued'"),
  ).toContain("COVERING INDEX idx_dream_actions_phase_status");
  expect(
    explain(
      "SELECT MAX(ts)FROM dispatch_events WHERE kind IN('dispatch.end','long_lived.tick.end')",
    ),
  ).toContain("idx_dispatch_events_activity_end_ts");
});
