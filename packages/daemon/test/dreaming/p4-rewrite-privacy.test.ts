import type { z } from "zod";

import { getConfig } from "@penumbra/config";
import { applySchema, type LlmCandidate, loadSqliteVec } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { buildDreamingConfig } from "@src/dreaming/config.js";
import { type DreamCycleDeps, runDreamCycle } from "@src/dreaming/cycle.js";
import { setRewriteForMemory } from "@src/dreaming/query-rewriter-cache.js";
import { runP5Phase } from "@src/dreaming/research.js";
import { REWRITE_POLICY_VERSION } from "@src/dreaming/rewrite-query-policy.js";
import type { LlmInvokeResult } from "@src/services/llm-invoke.js";

const TITLE = "Private control room routing conventions";
const LOCAL: LlmCandidate = {
  name: "local-granite",
  model: "granite",
  baseUrl: "http://127.0.0.1:18944/v1",
  provider: "local",
  auth: { source: "none" },
};

function fixture(): { db: Database; deps: DreamCycleDeps; now: number } {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 3 });
  const now = Date.now();
  const iso = new Date(now).toISOString();
  db.run(
    `INSERT INTO t2_memories(memory_id,project_id,user_id,kind,window_start,window_end,title,body,created_at,updated_at)
     VALUES('memory','project','user','note',?,?,?,'private context',?,?)`,
    [iso, iso, TITLE, iso, iso],
  );
  return {
    db,
    now,
    deps: {
      projectRegistry: {
        get: () => undefined,
        list: () => [{ project_id: "project", dreaming: { research_provider: "firecrawl" } }],
      },
      rewriterCandidates: [LOCAL],
      rewriterInventory: {
        collect: () =>
          Promise.resolve({ status: "ok", nodes: [], messages: [], models: [{ id: "granite" }] }),
      },
    },
  };
}

async function run(db: Database, deps: DreamCycleDeps, enabled = true): Promise<void> {
  await runDreamCycle(
    db,
    {
      ...buildDreamingConfig(getConfig({})),
      enabled: true,
      rewriterEnabled: enabled,
      rewriterModel: "granite",
      rewriterBaseUrl: LOCAL.baseUrl,
      perCycleUsd: 1,
      dailyUsd: 100,
      skipPhases: new Set(["P0", "P1", "P2", "P3", "P5", "P6", "P7", "P8"]),
    },
    deps,
  );
}

function queued(db: Database): unknown[] {
  return db
    .query(
      "SELECT payload_json FROM dream_actions WHERE phase='P4' AND action_type='research_query'",
    )
    .all();
}

test("disabled rewriting never sends an unreviewed memory title to research", async () => {
  const { db, deps } = fixture();
  try {
    await run(db, deps, false);
    expect(queued(db)).toEqual([]);
  } finally {
    db.close();
  }
});

for (const reason of [
  "timeout",
  "empty_response",
  "invalid_json",
  "schema_violation",
  "http_error",
] as const) {
  test(`rewriter ${reason} abstains without minting a title query or caching a model skip`, async () => {
    const { db, deps } = fixture();
    try {
      const failure: Extract<LlmInvokeResult<z.ZodType>, { ok: false }> = reason === "http_error"
        ? { ok: false, reason, status: 503, failureMessage: "unavailable" }
        : { ok: false, reason, failureMessage: "unavailable" };
      deps.llmInvoke = (): Promise<typeof failure> => Promise.resolve(failure);
      await run(db, deps);
      expect(queued(db)).toEqual([]);
      expect(db.query("SELECT COUNT(*) AS n FROM dream_query_rewrites").get()).toEqual({ n: 0 });
      expect(
        db
          .query(
            "SELECT last_failure_reason FROM subsystem_health WHERE subsystem='dream.query_rewrite'",
          )
          .get(),
      ).toEqual({ last_failure_reason: reason });
    } finally {
      db.close();
    }
  });
}

test("a discovery outage does not invoke a model or mint a title query", async () => {
  const { db, deps } = fixture();
  let called = false;
  try {
    deps.rewriterInventory = { collect: (): Promise<never> => Promise.reject(new Error("down")) };
    deps.llmInvoke = (): never => {
      called = true;
      throw new Error("must not invoke");
    };
    await run(db, deps);
    expect(called).toBe(false);
    expect(queued(db)).toEqual([]);
  } finally {
    db.close();
  }
});

test("a cached query containing a private endpoint is blocked even when the optional heuristic is disabled", async () => {
  const { db, deps, now } = fixture();
  const prior = process.env.PENUMBRA_DREAMING_QUERY_GATE_ENABLED;
  process.env.PENUMBRA_DREAMING_QUERY_GATE_ENABLED = "0";
  try {
    setRewriteForMemory({
      db,
      t2_memory_id: "memory",
      memory_updated_at_ms: now,
      model: "granite",
      now_ms: now,
      verdict: { kind: "query", query: "SQLite retry rules https://private.internal/customer" },
    });
    await run(db, deps);
    expect(queued(db)).toEqual([]);
  } finally {
    if (prior === undefined) delete process.env.PENUMBRA_DREAMING_QUERY_GATE_ENABLED;
    else process.env.PENUMBRA_DREAMING_QUERY_GATE_ENABLED = prior;
    db.close();
  }
});

test("a current-policy cached public query still queues without inference", async () => {
  const { db, deps, now } = fixture();
  try {
    setRewriteForMemory({
      db,
      t2_memory_id: "memory",
      memory_updated_at_ms: now,
      model: "granite",
      now_ms: now,
      verdict: { kind: "query", query: "SQLite WAL checkpoint reader contention" },
    });
    await run(db, deps);
    expect(queued(db)).toHaveLength(1);
  } finally {
    db.close();
  }
});

for (const payload of [
  { query: TITLE, source_memory_id: "memory" },
  { query: TITLE, source_memory_id: "memory", rewrite_policy_version: "legacy" },
  {
    query: "SQLite retries https://private.internal/customer rules",
    source_memory_id: "memory",
    rewrite_policy_version: REWRITE_POLICY_VERSION,
  },
]) {
  test("P5 blocks stale or unsafe memory-origin actions already in the queue", async () => {
    const { db, deps } = fixture();
    let adapterResolved = false;
    try {
      await run(db, deps, false);
      const cycle = db.query<{ cycle_id: string }, []>("SELECT cycle_id FROM dream_cycles").get()!;
      db.run(
        "INSERT INTO dream_actions(action_id,cycle_id,phase,action_type,confidence,status,target_ids,payload_json)VALUES('old',?,'P4','research_query',0.5,'queued','[\"project\"]',?)",
        [cycle.cycle_id, JSON.stringify(payload)],
      );
      await runP5Phase(db, cycle.cycle_id, buildDreamingConfig(getConfig({})), {
        projectRegistry: {
          get: () => ({ project_id: "project", dreaming: { research_provider: "firecrawl" } }),
        },
        getResearchAdapter: () => {
          adapterResolved = true;
          return null;
        },
      });
      expect(adapterResolved).toBe(false);
      expect(db.query("SELECT status FROM dream_actions WHERE action_id='old'").get()).toEqual({
        status: "failed",
      });
      expect(db.query("SELECT COUNT(*) AS n FROM dream_research_cache").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
}
