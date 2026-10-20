import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { registerWorkerForTest } from "@penumbra/daemon/test-utils";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { longLivedReconcileOrphansRoute } from "@src/routes/long-lived.js";
import { createDaemonFetchHandler } from "@src/serve.js";
import { OrphanHandoffRecoveryService } from "@src/services/orphan-handoff-recovery.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // SQLite may already be loaded by another test file.
}

const BOOT = "2026-10-07T12:00:00.000Z";

function seedTickDispatch(services: Services, id: string, claimedAt: string): void {
  services.handoffWriter.create({
    handoff_id: id,
    ts: claimedAt,
    from: "reactor",
    to: "tick-agent",
    message: "scheduled tick",
    conversation_id: id,
  });
  services.handoffWriter.approve(id, { resolved_by: "test", resolved_at: claimedAt });
  expect(services.handoffWriter.claimDispatch(id, "w1")).toBe(true);
  services.db
    .query(
      `UPDATE handoffs SET last_dispatch_started_at=?, dispatch_kind='long_lived_tick',
            long_lived_agent_id='tick-agent', long_lived_tick_id='tick-1', max_dispatch_attempts=3
            WHERE handoff_id=?`,
    )
    .run(claimedAt, id);
  services.dispatchEventLog.record({
    handoff_id: id,
    worker_id: "w1",
    source: "worker",
    kind: "dispatch.start",
    ts: claimedAt,
  });
}

test.each(["tick-first", "dispatch-first"])(
  "boot recovery fails orphan ticks without requeueing (%s)",
  async (order) => {
    const db = new Database(":memory:");
    try {
      loadSqliteVec(db);
      migrate(db, { embeddingDim: 384 });
      const services = buildServices({
        env: {},
        input: {},
        storageRoot: "/tmp/orphan-tick-test",
        db,
        embedder: new TestEmbedder({ dim: 384 }),
        clock: () => new Date(BOOT),
      });
      db.query(
        `INSERT INTO long_lived_agents
         (id, display_name, working_memory_json, standing_brief, created_at, updated_at)
         VALUES ('tick-agent', 'Tick Agent', '{}', 'scheduled work', 1, 1)`,
      ).run();
      db.query(
        `INSERT INTO long_lived_ticks (id, agent_id, chain_id, trigger_kind, started_at)
         VALUES ('tick-1', 'tick-agent', 'old-tick', 'cron', 1)`,
      ).run();
      seedTickDispatch(services, "old-tick", "2026-10-07T11:59:00.000Z");
      seedTickDispatch(services, "at-boot", BOOT);
      seedTickDispatch(services, "live-tick", "2026-10-07T12:01:00.000Z");
      const recovery = new OrphanHandoffRecoveryService(services, { intervalMs: 0 });
      const handler = createDaemonFetchHandler({
        services,
        token: "test-token",
        orphanHandoffRecovery: recovery,
      });
      const { worker_token } = await registerWorkerForTest({
        baseUrl: "http://x",
        sharedBearer: "test-token",
        worker_id: "w1",
        fetcher: ((input: string | URL | Request, init?: RequestInit) =>
          handler(new Request(input, init))) as typeof fetch,
      });
      const tickReconcile = async (): Promise<void> => {
        const res = longLivedReconcileOrphansRoute(new Request("http://x"), services);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ reconciled: 1 });
      };
      const dispatchReconcile = async (): Promise<void> => {
        const res = await handler(
          new Request("http://x/worker/reconcile-orphans", {
            method: "POST",
            headers: { authorization: `Bearer ${worker_token}` },
            body: JSON.stringify({ worker_id: "w1", claimed_before: BOOT }),
          }),
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          requeued: 0,
          exhausted: 1,
          requeuedRowIds: [],
          exhaustedRowIds: ["old-tick"],
        });
      };
      if (order === "tick-first") {
        await tickReconcile();
        await dispatchReconcile();
      } else {
        await dispatchReconcile();
        await tickReconcile();
      }
      expect(services.handoffReader.get("old-tick")).toMatchObject({
        status: "failed",
        resolution_reason: "failed_worker_restart: orphaned long-lived tick",
        dispatch_attempts: 1,
      });
      expect(
        db.query("SELECT completed_at, outcome FROM long_lived_ticks WHERE id='tick-1'").get(),
      ).toEqual({ completed_at: Date.parse(BOOT), outcome: "orphan_recovered" });
      for (const id of ["at-boot", "live-tick"]) {
        expect(services.handoffReader.get(id)).toMatchObject({
          status: "dispatched",
          worker_id: "w1",
        });
      }
      const kinds = services.dispatchEventLog.listByHandoff("old-tick").map((event) => event.kind);
      expect(kinds).toContain("worker.recovery.exhausted");
      expect(kinds).not.toContain("worker.recovery.requeued");
      expect(kinds).not.toContain("claim.reoffer");
      expect(recovery.runOnce("w1", { workerKnownDead: true, claimedBefore: BOOT })).toMatchObject({
        requeued: 0,
        exhausted: 0,
      });
    } finally {
      db.close();
    }
  },
);
