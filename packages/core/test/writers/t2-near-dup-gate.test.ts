/* eslint-disable @typescript-eslint/no-explicit-any -- sqlite row fixtures */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec, migrate } from "../../src/index.js";
import { T2Promotion } from "../../src/writers/t2.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

const PROMOTION_GATE_ENV = "PENUMBRA_PROMOTION_GATE";
const NEAR_DUP_GATE_ENV = "PENUMBRA_PROMOTION_NEAR_DUP_GATE";

type Extraction = {
  title: string;
  body: string;
  kind: string;
  obs_type?: string;
  why?: string;
  depth?: number;
  is_episodic?: boolean;
  promote?: boolean;
};

class DeterministicEmbedder {
  constructor(private readonly vectors: Map<string, Float32Array>) {}

  async embed(input: string[]): Promise<Float32Array[]> {
    return input.map((text) => {
      const vec = this.vectors.get(text);
      if (!vec) throw new Error(`missing deterministic vector for: ${text}`);
      return vec;
    });
  }
}

let db: Database;
let uuidSeq = 0;

beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 4 });
  uuidSeq = 0;
  delete process.env[PROMOTION_GATE_ENV];
  delete process.env[NEAR_DUP_GATE_ENV];
});

function seedRollup(rollupId: string, sessionId: string): void {
  db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                             n_events, lane_breakdown_json, provider_breakdown_json)
     VALUES (?, 'proj', 'u1', ?, '2026-04-27T10:00:00Z', '2026-04-27T10:05:00Z', 5, '{}', '{}')`,
    [rollupId, sessionId],
  );

  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
     VALUES (?, ?, ?, 'mcp', 'u1', 'm1', ?, 'agent-prompt', 'local', '{}', ?)`,
    [
      `e-${sessionId}-1`,
      "2026-04-27T10:00:00Z",
      "2026-04-27T10:00:00Z",
      sessionId,
      "Long enough transcript prompt for promotion gate validation.",
    ],
  );

  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
     VALUES (?, ?, ?, 'mcp', 'u1', 'm1', ?, 'agent-response', 'local', '{}', ?)`,
    [
      `e-${sessionId}-2`,
      "2026-04-27T10:05:00Z",
      "2026-04-27T10:05:00Z",
      sessionId,
      "Long enough transcript response for promotion gate validation.",
    ],
  );
}

function makePromotion(embedder: DeterministicEmbedder, llm: (transcript: string) => Promise<Extraction[]>) {
  return new T2Promotion({
    db,
    embedder,
    clock: () => new Date("2026-04-27T15:00:00Z"),
    uuid: () => `m-${++uuidSeq}`,
    llm,
    minTranscriptChars: 0,
  });
}

describe("T2Promotion creation gate + near-dup gate", () => {
  test("default-off parity: extraction filter gates do not apply when flags are unset", async () => {
    seedRollup("r-default-off", "s-default-off");

    const vecs = new Map<string, Float32Array>([
      ["tiny", new Float32Array([1, 0, 0, 0])],
      ["standing", new Float32Array([0, 1, 0, 0])],
      ["episodic", new Float32Array([0, 0, 1, 0])],
    ]);

    const prom = makePromotion(
      new DeterministicEmbedder(vecs),
      async () => [
        {
          title: "tiny",
          body: "tiny",
          kind: "fact",
          depth: 1,
          promote: false,
        },
        {
          title: "standing",
          body: "standing",
          kind: "preference",
          obs_type: "standing_brief",
          promote: false,
          depth: 1,
        },
        {
          title: "episodic",
          body: "episodic",
          kind: "fact",
          is_episodic: true,
          promote: false,
          depth: 1,
        },
      ],
    );

    const count = await prom.promoteRollup("r-default-off");
    expect(count).toBe(3);

    const row = db
      .query<{ t2_promoted_at: string | null; promotion_skipped_at: string | null }, [string]>(
        "SELECT t2_promoted_at, promotion_skipped_at FROM t1_rollups WHERE rollup_id = ?",
      )
      .get("r-default-off");
    expect(row?.t2_promoted_at).toBe("2026-04-27T15:00:00.000Z");
    expect(row?.promotion_skipped_at).toBeNull();
  });

  test("promotion gate drops episodic + standing_brief + shallow-short extractions, keeps semantic/deep", async () => {
    process.env[PROMOTION_GATE_ENV] = "1";
    seedRollup("r-gated", "s-gated");

    const keptSemanticBody =
      "recall.ts:172 filters retired_at IS NULL and keeps retrieval scoped to active memory rows.";
    const keptDeepShortBody = "Short body with deep rationale.";

    const vecs = new Map<string, Float32Array>([
      ["episodic body should drop", new Float32Array([1, 0, 0, 0])],
      ["standing brief body should drop", new Float32Array([0, 1, 0, 0])],
      ["tiny", new Float32Array([0, 0, 1, 0])],
      [keptSemanticBody, new Float32Array([0, 0, 0, 1])],
      [keptDeepShortBody, new Float32Array([0.5, 0.5, 0.5, 0.5])],
    ]);

    const prom = makePromotion(
      new DeterministicEmbedder(vecs),
      async () => [
        {
          title: "episodic",
          body: "episodic body should drop",
          kind: "fact",
          is_episodic: true,
          obs_type: "is_episodic",
          promote: false,
          depth: 1,
        },
        {
          title: "standing brief",
          body: "standing brief body should drop",
          kind: "preference",
          obs_type: "standing_brief",
          promote: false,
          depth: 2,
        },
        {
          title: "tiny shallow",
          body: "tiny",
          kind: "fact",
          depth: 1,
          promote: true,
        },
        {
          title: "semantic keep",
          body: keptSemanticBody,
          kind: "knowledge",
          why: "grounded why",
          obs_type: "fact",
          promote: true,
          depth: 1,
        },
        {
          title: "deep short keep",
          body: keptDeepShortBody,
          kind: "decision",
          why: "depth escape hatch should retain this",
          obs_type: "fact",
          promote: true,
          depth: 2,
        },
      ],
    );

    const count = await prom.promoteRollup("r-gated");
    expect(count).toBe(2);

    const rows = db
      .query<{ title: string }, []>("SELECT title FROM t2_memories ORDER BY rowid ASC")
      .all()
      .map((r) => r.title);
    expect(rows).toEqual(["semantic keep", "deep short keep"]);
  });

  test("promotion gate marks dropped rollups as skipped and removes them from eligibility", async () => {
    process.env[PROMOTION_GATE_ENV] = "1";
    seedRollup("r-drop", "s-drop");

    const vecs = new Map<string, Float32Array>([["drop me", new Float32Array([1, 0, 0, 0])]]);

    const prom = makePromotion(new DeterministicEmbedder(vecs), async () => [
      {
        title: "standing brief",
        body: "drop me",
        kind: "preference",
        obs_type: "standing_brief",
        promote: false,
        depth: 1,
      },
    ]);

    const count = await prom.promoteRollup("r-drop");
    expect(count).toBe(0);

    const row = db
      .query<
        {
          t2_promoted_at: string | null;
          failed_promotion_attempts: number;
          promotion_skipped_at: string | null;
        },
        [string]
      >(
        "SELECT t2_promoted_at, failed_promotion_attempts, promotion_skipped_at FROM t1_rollups WHERE rollup_id = ?",
      )
      .get("r-drop");

    expect(row).toEqual({
      t2_promoted_at: null,
      failed_promotion_attempts: 0,
      promotion_skipped_at: "2026-04-27T15:00:00.000Z",
    });

    const eligible = prom.detectEligibleRollups(24, new Date("2026-04-28T16:00:00Z"), 1);
    expect(eligible).not.toContain("r-drop");
  });

  test("near-dup gate blocks weaker duplicate and marks rollup skipped", async () => {
    process.env[NEAR_DUP_GATE_ENV] = "1";

    const existingBody =
      "Durable architectural memory with enough density and explicit why grounding for long term recall.";
    const dupeBody =
      "Durable architectural memory with enough density and explicit why grounding for long term recall (short).";

    const vecs = new Map<string, Float32Array>([
      [existingBody, new Float32Array([1, 0, 0, 0])],
      [dupeBody, new Float32Array([0.99, 0.01, 0, 0])],
    ]);

    seedRollup("r-a", "s-a");
    const p1 = makePromotion(new DeterministicEmbedder(vecs), async () => [
      {
        title: "existing",
        body: existingBody,
        kind: "knowledge",
        why: "explains architectural tradeoff",
        depth: 3,
      },
    ]);
    expect(await p1.promoteRollup("r-a")).toBe(1);

    seedRollup("r-b", "s-b");
    const p2 = makePromotion(new DeterministicEmbedder(vecs), async () => [
      {
        title: "candidate weaker",
        body: dupeBody,
        kind: "knowledge",
        depth: 1,
      },
    ]);
    expect(await p2.promoteRollup("r-b")).toBe(0);

    const memoryCount = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM t2_memories").get();
    expect(memoryCount?.c).toBe(1);

    const rollup = db
      .query<
        {
          t2_promoted_at: string | null;
          failed_promotion_attempts: number;
          promotion_skipped_at: string | null;
        },
        [string]
      >(
        "SELECT t2_promoted_at, failed_promotion_attempts, promotion_skipped_at FROM t1_rollups WHERE rollup_id = ?",
      )
      .get("r-b");
    expect(rollup).toEqual({
      t2_promoted_at: null,
      failed_promotion_attempts: 0,
      promotion_skipped_at: "2026-04-27T15:00:00.000Z",
    });

    const eligible = p2.detectEligibleRollups(24, new Date("2026-04-28T16:00:00Z"), 1);
    expect(eligible).not.toContain("r-b");
  });

  test("near-dup gate queues retire action when stronger candidate wins", async () => {
    process.env[NEAR_DUP_GATE_ENV] = "1";

    const weakBody = "Weak memory body with little context.";
    const strongBody =
      "Weak memory body with little context, but now expanded with why-grounded decision rationale and operational constraints.";

    const vecs = new Map<string, Float32Array>([
      [weakBody, new Float32Array([1, 0, 0, 0])],
      [strongBody, new Float32Array([0.98, 0.02, 0, 0])],
    ]);

    seedRollup("r-c", "s-c");
    const p1 = makePromotion(new DeterministicEmbedder(vecs), async () => [
      {
        title: "existing weak",
        body: weakBody,
        kind: "fact",
        depth: 1,
      },
    ]);
    expect(await p1.promoteRollup("r-c")).toBe(1);

    seedRollup("r-d", "s-d");
    const p2 = makePromotion(new DeterministicEmbedder(vecs), async () => [
      {
        title: "candidate strong",
        body: strongBody,
        kind: "fact",
        why: "contains rationale missing from prior memory",
        depth: 3,
      },
    ]);
    expect(await p2.promoteRollup("r-d")).toBe(1);

    const memoryCount = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM t2_memories").get();
    expect(memoryCount?.c).toBe(2);

    const existingWeak = db
      .query<{ memory_id: string; retired_at: number | null }, [string]>(
        "SELECT memory_id, retired_at FROM t2_memories WHERE body = ?",
      )
      .get(weakBody);
    expect(existingWeak).toBeDefined();
    expect(existingWeak?.retired_at).toBeNull();

    const retireAction = db
      .query<
        {
          action_type: string;
          phase: string;
          status: string;
          target_ids: string;
          confidence: number;
        },
        []
      >(
        "SELECT action_type, phase, status, target_ids, confidence FROM dream_actions WHERE action_type = 'retire' ORDER BY rowid DESC LIMIT 1",
      )
      .get();
    expect(retireAction).toEqual({
      action_type: "retire",
      phase: "P3",
      status: "queued",
      target_ids: JSON.stringify([existingWeak?.memory_id]),
      confidence: retireAction?.confidence,
    });
    expect(retireAction?.confidence).toBeGreaterThan(0.95);
    expect(retireAction?.confidence).toBeLessThan(1);

    const cycle = db
      .query<{ started_at: string }, []>(
        "SELECT started_at FROM dream_cycles WHERE cycle_id = 't2-promotion-near-dup' LIMIT 1",
      )
      .get();
    expect(cycle?.started_at).toBe("2026-04-27T15:00:00.000Z");
  });

  test("near-dup gate marks promotion skipped atomically when all candidates are blocked", async () => {
    process.env[NEAR_DUP_GATE_ENV] = "1";

    const existingBody =
      "Durable architectural memory with enough density and explicit why grounding for long term recall.";
    const dupeBody =
      "Durable architectural memory with enough density and explicit why grounding for long term recall (short).";

    const vecs = new Map<string, Float32Array>([
      [existingBody, new Float32Array([1, 0, 0, 0])],
      [dupeBody, new Float32Array([0.99, 0.01, 0, 0])],
    ]);

    seedRollup("r-atomic-a", "s-atomic-a");
    const first = makePromotion(new DeterministicEmbedder(vecs), async () => [
      {
        title: "existing",
        body: existingBody,
        kind: "knowledge",
        why: "explains architectural tradeoff",
        depth: 3,
      },
    ]);
    expect(await first.promoteRollup("r-atomic-a")).toBe(1);

    seedRollup("r-atomic-b", "s-atomic-b");
    const blocked = makePromotion(new DeterministicEmbedder(vecs), async () => [
      {
        title: "candidate weaker",
        body: dupeBody,
        kind: "knowledge",
        depth: 1,
      },
    ]);
    const originalTransaction = db.transaction.bind(db);
    let inTransaction = false;
    db.transaction = ((fn: () => unknown) =>
      originalTransaction(() => {
        inTransaction = true;
        try {
          return fn();
        } finally {
          inTransaction = false;
        }
      })) as typeof db.transaction;
    const markCallsInTxn: boolean[] = [];
    const originalMarkSkipped = (blocked as any).markPromotionSkipped.bind(blocked);
    (blocked as any).markPromotionSkipped = (rid: string) => {
      markCallsInTxn.push(inTransaction);
      return originalMarkSkipped(rid);
    };
    expect(await blocked.promoteRollup("r-atomic-b")).toBe(0);

    const row = db
      .query<{ t2_promoted_at: string | null; promotion_skipped_at: string | null }, [string]>(
        "SELECT t2_promoted_at, promotion_skipped_at FROM t1_rollups WHERE rollup_id = ?",
      )
      .get("r-atomic-b");
    expect(row).toEqual({
      t2_promoted_at: null,
      promotion_skipped_at: "2026-04-27T15:00:00.000Z",
    });
    expect(markCallsInTxn).toEqual([true]);
  });

  test("near-dup KNN read runs outside transaction and still blocks weaker duplicate", async () => {
    process.env[NEAR_DUP_GATE_ENV] = "1";

    const existingBody =
      "Durable architectural memory with enough density and explicit why grounding for long term recall.";
    const dupeBody =
      "Durable architectural memory with enough density and explicit why grounding for long term recall (short).";

    const vecs = new Map<string, Float32Array>([
      [existingBody, new Float32Array([1, 0, 0, 0])],
      [dupeBody, new Float32Array([0.99, 0.01, 0, 0])],
    ]);

    seedRollup("r-prefetch-a", "s-prefetch-a");
    const first = makePromotion(new DeterministicEmbedder(vecs), async () => [
      {
        title: "existing",
        body: existingBody,
        kind: "knowledge",
        why: "explains architectural tradeoff",
        depth: 3,
      },
    ]);
    expect(await first.promoteRollup("r-prefetch-a")).toBe(1);

    seedRollup("r-prefetch-b", "s-prefetch-b");
    const blocked = makePromotion(new DeterministicEmbedder(vecs), async () => [
      {
        title: "candidate weaker",
        body: dupeBody,
        kind: "knowledge",
        depth: 1,
      },
    ]);

    const originalTransaction = db.transaction.bind(db);
    let inTransaction = false;
    db.transaction = ((fn: () => unknown) =>
      originalTransaction(() => {
        inTransaction = true;
        try {
          return fn();
        } finally {
          inTransaction = false;
        }
      })) as typeof db.transaction;

    const originalQuery = db.query.bind(db);
    const nearDupQueryInTxn: boolean[] = [];
    db.query = ((sql: string) => {
      if (sql.includes("ORDER BY vec_distance_cosine")) nearDupQueryInTxn.push(inTransaction);
      return originalQuery(sql);
    }) as typeof db.query;

    expect(await blocked.promoteRollup("r-prefetch-b")).toBe(0);
    expect(nearDupQueryInTxn.length).toBeGreaterThan(0);
    expect(nearDupQueryInTxn.every((v) => v === false)).toBe(true);
  });

  test("near-dup gate merges displaced candidate retire targets into the winning candidate", async () => {
    process.env[NEAR_DUP_GATE_ENV] = "1";

    const existingABody = "Existing weak A short.";
    const existingBBody = "Existing weak B short.";
    const candidateWeakBody = "Candidate weak version.";
    const candidateStrongBody =
      "Candidate strong version with deeper why grounding and explicit operational constraints for durable retention.";

    const vecs = new Map<string, Float32Array>([
      [existingABody, new Float32Array([1, 0, 0, 0])],
      [existingBBody, new Float32Array([0.93, 0.367, 0, 0])],
      [candidateWeakBody, new Float32Array([0.996, 0.087, 0, 0])],
      [candidateStrongBody, new Float32Array([0.946, 0.325, 0, 0])],
    ]);

    seedRollup("r-displace-a", "s-displace-a");
    const p1 = makePromotion(new DeterministicEmbedder(vecs), async () => [
      { title: "existing A", body: existingABody, kind: "fact", depth: 1 },
    ]);
    expect(await p1.promoteRollup("r-displace-a")).toBe(1);

    seedRollup("r-displace-b", "s-displace-b");
    const p2 = makePromotion(new DeterministicEmbedder(vecs), async () => [
      { title: "existing B", body: existingBBody, kind: "fact", depth: 1 },
    ]);
    expect(await p2.promoteRollup("r-displace-b")).toBe(1);

    seedRollup("r-displace-c", "s-displace-c");
    const p3 = makePromotion(new DeterministicEmbedder(vecs), async () => [
      {
        title: "candidate weak",
        body: candidateWeakBody,
        kind: "fact",
        depth: 1,
      },
      {
        title: "candidate strong",
        body: candidateStrongBody,
        kind: "fact",
        why: "better explanation",
        depth: 3,
      },
    ]);
    expect(await p3.promoteRollup("r-displace-c")).toBe(1);

    const existingIds = db
      .query<{ memory_id: string }, [string, string]>(
        "SELECT memory_id FROM t2_memories WHERE body IN (?, ?) ORDER BY rowid ASC",
      )
      .all(existingABody, existingBBody)
      .map((r) => r.memory_id);

    const retireTargets = db
      .query<{ target_ids: string }, []>(
        "SELECT target_ids FROM dream_actions WHERE action_type = 'retire' AND status = 'queued' ORDER BY rowid ASC",
      )
      .all()
      .map((r) => JSON.parse(r.target_ids)[0] as string)
      .sort();

    expect(retireTargets).toEqual([...existingIds].sort());
  });

  test("near-dup gate skips malformed existing embeddings with a warning instead of throwing", async () => {
    process.env[NEAR_DUP_GATE_ENV] = "1";

    const existingBody =
      "Malformed embedding holder body that should be ignored during near-dup candidate reads.";
    const candidateBody =
      "Distinct candidate body that should still promote even when one existing vec row is malformed.";

    const vecs = new Map<string, Float32Array>([
      [existingBody, new Float32Array([1, 0, 0, 0])],
      [candidateBody, new Float32Array([0, 1, 0, 0])],
    ]);

    seedRollup("r-bad-embed-a", "s-bad-embed-a");
    const first = makePromotion(new DeterministicEmbedder(vecs), async () => [
      { title: "existing", body: existingBody, kind: "fact", depth: 1 },
    ]);
    expect(await first.promoteRollup("r-bad-embed-a")).toBe(1);

    const existing = db
      .query<{ rowid: number; memory_id: string }, [string]>("SELECT rowid, memory_id FROM t2_memories WHERE body = ?")
      .get(existingBody);
    expect(existing).toBeDefined();

    const originalQuery = db.query.bind(db);
    db.query = ((sql: string) => {
      const statement = originalQuery(sql);
      if (!sql.includes("ORDER BY vec_distance_cosine")) return statement;
      return {
        ...statement,
        all: (...args: unknown[]) => {
          const rows = statement.all(...(args as [string | null, Float32Array, number])) as Array<{
            memory_id: string;
            body: string;
            why: string | null;
            depth: number | null;
            embedding: unknown;
          }>;
          return rows.map((row) =>
            row.memory_id !== existing!.memory_id
              ? row
              : {
                  ...row,
                  embedding: new Uint8Array(new ArrayBuffer(3)),
                },
          );
        },
      };
    }) as typeof db.query;

    const warnings: string[] = [];
    const oldWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      seedRollup("r-bad-embed-b", "s-bad-embed-b");
      const second = makePromotion(new DeterministicEmbedder(vecs), async () => [
        { title: "candidate", body: candidateBody, kind: "fact", depth: 1 },
      ]);
      await expect(second.promoteRollup("r-bad-embed-b")).resolves.toBe(1);
    } finally {
      console.warn = oldWarn;
    }

    expect(warnings.some((msg) => msg.includes("failed to decode embedding") && msg.includes(existing!.memory_id))).toBe(
      true,
    );
  });

  test("near-dup retire dedup treats approved and auto_applied actions as already handled", async () => {
    process.env[NEAR_DUP_GATE_ENV] = "1";

    const weakBody = "Weak memory body with little context.";
    const strongBody =
      "Weak memory body with little context, but now expanded with why-grounded decision rationale and operational constraints.";

    const vecs = new Map<string, Float32Array>([
      [weakBody, new Float32Array([1, 0, 0, 0])],
      [strongBody, new Float32Array([0.98, 0.02, 0, 0])],
    ]);

    seedRollup("r-dedup-status-a", "s-dedup-status-a");
    const p1 = makePromotion(new DeterministicEmbedder(vecs), async () => [
      {
        title: "existing weak",
        body: weakBody,
        kind: "fact",
        depth: 1,
      },
    ]);
    expect(await p1.promoteRollup("r-dedup-status-a")).toBe(1);

    const weakId = db
      .query<{ memory_id: string }, [string]>("SELECT memory_id FROM t2_memories WHERE body = ?")
      .get(weakBody)?.memory_id;
    expect(weakId).toBeTruthy();
    const targetIds = JSON.stringify([weakId]);

    db.run(
      `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
       VALUES('manual-approved', '2026-04-27T00:00:00.000Z', 'manual', 0, 'completed', '[]')`,
    );
    db.run(
      `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
       VALUES('a-approved', 'manual-approved', 'P3', 'retire', 0.99, 'approved', ?, '{}')`,
      [targetIds],
    );
    db.run("DELETE FROM dream_actions WHERE action_type = 'retire' AND status = 'queued' AND target_ids = ?", [targetIds]);

    seedRollup("r-dedup-status-b", "s-dedup-status-b");
    const p2 = makePromotion(new DeterministicEmbedder(vecs), async () => [
      {
        title: "candidate strong",
        body: strongBody,
        kind: "fact",
        why: "contains rationale missing from prior memory",
        depth: 3,
      },
    ]);
    expect(await p2.promoteRollup("r-dedup-status-b")).toBe(1);

    const actionsAfterApproved = db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM dream_actions WHERE action_type = 'retire' AND target_ids = ?",
      )
      .get(targetIds)?.c;
    expect(actionsAfterApproved).toBe(1);

    db.run("UPDATE dream_actions SET status = 'auto_applied' WHERE action_id = 'a-approved'");

    seedRollup("r-dedup-status-c", "s-dedup-status-c");
    const p3 = makePromotion(new DeterministicEmbedder(vecs), async () => [
      {
        title: "candidate strongest",
        body: `${strongBody} plus one more precision sentence`,
        kind: "fact",
        why: "keeps improving",
        depth: 4,
      },
    ]);

    vecs.set(`${strongBody} plus one more precision sentence`, new Float32Array([0.99, 0.01, 0, 0]));
    expect(await p3.promoteRollup("r-dedup-status-c")).toBe(1);

    const actionsAfterAutoApplied = db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM dream_actions WHERE action_type = 'retire' AND target_ids = ?",
      )
      .get(targetIds)?.c;
    expect(actionsAfterAutoApplied).toBe(1);
  });

  test("near-dup gate keeps semantically distinct candidates (cosine around 0.5)", async () => {
    process.env[NEAR_DUP_GATE_ENV] = "1";

    const bodyA = "Distinct memory A";
    const bodyB = "Distinct memory B";

    const vecs = new Map<string, Float32Array>([
      [bodyA, new Float32Array([1, 0, 0, 0])],
      [bodyB, new Float32Array([0.5, 0.8660254, 0, 0])],
    ]);

    seedRollup("r-e", "s-e");
    const p1 = makePromotion(new DeterministicEmbedder(vecs), async () => [
      {
        title: "A",
        body: bodyA,
        kind: "fact",
        depth: 1,
      },
    ]);
    expect(await p1.promoteRollup("r-e")).toBe(1);

    seedRollup("r-f", "s-f");
    const p2 = makePromotion(new DeterministicEmbedder(vecs), async () => [
      {
        title: "B",
        body: bodyB,
        kind: "fact",
        depth: 1,
      },
    ]);
    expect(await p2.promoteRollup("r-f")).toBe(1);

    const memoryCount = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM t2_memories").get();
    expect(memoryCount?.c).toBe(2);

    const queuedRetire = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM dream_actions WHERE action_type = 'retire' AND status = 'queued'",
      )
      .get();
    expect(queuedRetire?.c).toBe(0);
  });

  test("near-dup gate throws on embedding dimension mismatch", async () => {
    process.env[NEAR_DUP_GATE_ENV] = "1";

    const baseBody = "baseline body for near-dup";
    const mismatchBody = "mismatch body for near-dup";
    const vecs = new Map<string, Float32Array>([
      [baseBody, new Float32Array([1, 0, 0, 0])],
      [mismatchBody, new Float32Array([1, 0, 0])],
    ]);

    seedRollup("r-dim-a", "s-dim-a");
    const p1 = makePromotion(new DeterministicEmbedder(vecs), async () => [
      {
        title: "baseline",
        body: baseBody,
        kind: "fact",
      },
    ]);
    expect(await p1.promoteRollup("r-dim-a")).toBe(1);

    seedRollup("r-dim-b", "s-dim-b");
    const p2 = makePromotion(new DeterministicEmbedder(vecs), async () => [
      {
        title: "mismatch",
        body: mismatchBody,
        kind: "fact",
      },
    ]);
    await expect(p2.promoteRollup("r-dim-b")).rejects.toThrow(/dimension/i);

    const failed = db
      .query<{ failed_promotion_attempts: number }, [string]>(
        "SELECT failed_promotion_attempts FROM t1_rollups WHERE rollup_id = ?",
      )
      .get("r-dim-b");
    expect(failed?.failed_promotion_attempts).toBe(1);
  });
});
