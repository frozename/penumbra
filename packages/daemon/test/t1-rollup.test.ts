import { loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { createRollupWorker } from "../src/workers/t1-rollup.js";
import { makeTempDaemon } from "./helpers.js";
import { serviceTest } from "./helpers/service-gates.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

serviceTest("rollup worker rolls idle sessions and rewrites the context file", async () => {
  const d = makeTempDaemon();
  d.services.supervisor.stopAll();
  try {
    // Seed a T0 event in an old session (past idle threshold). ingest_ts stays
    // inside the bounded-tick lookback so the session is visible on every tick.
    const oldTs = "2026-04-22T00:00:00Z";
    const ingestTs = "2026-04-23T11:55:00Z";
    d.services.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id,
        session_id, event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
        request_id, payload_json, payload_summary)
       VALUES(?, ?, ?, 'mcp', null, 'pA', 'u', 'm', ?, 'agent-prompt', 'local', null, null, null, null, null, null, null, '{}', ?)`,
      ["e1", oldTs, ingestTs, "old-session", "hello"],
    );

    const worker = createRollupWorker({
      services: d.services,
      idleMinutes: 5,
    });
    await worker.tick();

    const count = d.services.db.query<{ c: number }, []>("SELECT COUNT(*) c FROM t1_rollups").get()!
      .c;
    expect(count).toBe(1);

    const ctx = Bun.file(`${d.dir}/context/pA/latest.md`);
    expect(await ctx.exists()).toBe(true);
  } finally {
    d.stop();
  }
});

serviceTest("rollup worker re-reads MEMORY_OVERWRITE_ON_REROLL per tick", async () => {
  const d = makeTempDaemon();
  d.services.supervisor.stopAll();
  try {
    const oldTs = "2026-04-22T00:00:00Z";
    const ingestTs = "2026-04-23T11:55:00Z";
    d.services.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, session_id, event_type, lane, project_id, user_id, machine_id, payload_json, payload_summary)
       VALUES('e1', ?, ?, 'mcp', 's1', 'agent-prompt', 'local', 'p1', 'u1', 'm1', '{}', 'hello')`,
      [oldTs, ingestTs],
    );

    const worker = createRollupWorker({
      services: d.services,
      idleMinutes: 5,
    });

    // 1. First tick - default behavior (no overwrite)
    await worker.tick();
    const rollupId1 = d.services.db
      .query<{ rollup_id: string }, []>("SELECT rollup_id FROM t1_rollups")
      .get()?.rollup_id;
    expect(rollupId1).toBeDefined();

    // Add a new event to the same session
    const newTs = "2026-04-22T00:01:00Z";
    d.services.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, session_id, event_type, lane, project_id, user_id, machine_id, payload_json, payload_summary)
       VALUES('e2', ?, ?, 'mcp', 's1', 'agent-prompt', 'local', 'p1', 'u1', 'm1', '{}', 'world')`,
      [newTs, ingestTs],
    );

    // 2. Set env to true - should overwrite
    process.env.MEMORY_OVERWRITE_ON_REROLL = "true";
    await worker.tick();
    const rollupId2 = d.services.db
      .query<{ rollup_id: string }, []>("SELECT rollup_id FROM t1_rollups")
      .get()?.rollup_id;
    expect(rollupId2).toBeDefined();
    expect(rollupId2).not.toBe(rollupId1); // It should be a new ID because it was overwritten

    // 3. Unset env - should NOT overwrite if we add another event
    delete process.env.MEMORY_OVERWRITE_ON_REROLL;
    const newerTs = "2026-04-22T00:02:00Z";
    d.services.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, session_id, event_type, lane, project_id, user_id, machine_id, payload_json, payload_summary)
       VALUES('e3', ?, ?, 'mcp', 's1', 'agent-prompt', 'local', 'p1', 'u1', 'm1', '{}', 'again')`,
      [newerTs, ingestTs],
    );
    await worker.tick();
    const rollupId3 = d.services.db
      .query<{ rollup_id: string }, []>("SELECT rollup_id FROM t1_rollups")
      .get()?.rollup_id;
    expect(rollupId3).toBe(rollupId2); // It should append, keeping the same ID
  } finally {
    delete process.env.MEMORY_OVERWRITE_ON_REROLL;
    d.stop();
  }
});

serviceTest("rollup worker opts take precedence over MEMORY_OVERWRITE_ON_REROLL env", async () => {
  const d = makeTempDaemon();
  d.services.supervisor.stopAll();
  try {
    const oldTs = "2026-04-22T00:00:00Z";
    const ingestTs = "2026-04-23T11:55:00Z";
    d.services.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, session_id, event_type, lane, project_id, user_id, machine_id, payload_json, payload_summary)
       VALUES('e1', ?, ?, 'mcp', 's1', 'agent-prompt', 'local', 'p1', 'u1', 'm1', '{}', 'hello')`,
      [oldTs, ingestTs],
    );

    process.env.MEMORY_OVERWRITE_ON_REROLL = "true";
    // Opts set to false should win over env=true
    const worker = createRollupWorker({
      services: d.services,
      idleMinutes: 5,
      overwriteOnReroll: false,
    });

    await worker.tick();
    const rollupId1 = d.services.db
      .query<{ rollup_id: string }, []>("SELECT rollup_id FROM t1_rollups")
      .get()?.rollup_id;

    const newTs = "2026-04-22T00:01:00Z";
    d.services.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, session_id, event_type, lane, project_id, user_id, machine_id, payload_json, payload_summary)
       VALUES('e2', ?, ?, 'mcp', 's1', 'agent-prompt', 'local', 'p1', 'u1', 'm1', '{}', 'world')`,
      [newTs, ingestTs],
    );
    await worker.tick();
    const rollupId2 = d.services.db
      .query<{ rollup_id: string }, []>("SELECT rollup_id FROM t1_rollups")
      .get()?.rollup_id;
    expect(rollupId2).toBe(rollupId1); // Appended, not overwritten, because opts.overwriteOnReroll=false wins
  } finally {
    delete process.env.MEMORY_OVERWRITE_ON_REROLL;
    d.stop();
  }
});

test("rollup worker scans unbounded on the first tick and every 60th tick only", async () => {
  const calls: ({ ingestedSince?: string } | undefined)[] = [];
  const stubT1 = {
    detectIdleSessions(
      _idleMinutes: number,
      _now: Date,
      opts?: { ingestedSince?: string },
    ): string[] {
      calls.push(opts);
      return [];
    },
    rollupSession: (_sessionId: string): Promise<string | null> => Promise.resolve(null),
  };
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = {
    db,
    clock: () => new Date("2026-04-23T12:00:00Z"),
    uuid: () => "u",
    embedder: null,
    storageRoot: "/tmp/rollup-cadence-test",
    log: { warn: () => undefined },
  } as unknown as Services;

  const worker = createRollupWorker({ services, idleMinutes: 10, t1: stubT1 });
  for (let i = 0; i < 62; i++) await worker.tick();

  expect(calls).toHaveLength(62);
  expect(calls[0]).toBeUndefined();
  expect(calls[60]).toBeUndefined();
  const bounded = calls.filter((c) => c !== undefined);
  expect(bounded).toHaveLength(60);
  for (const call of bounded) {
    expect(call).toEqual({ ingestedSince: "2026-04-23T11:00:00.000Z" });
  }
});
