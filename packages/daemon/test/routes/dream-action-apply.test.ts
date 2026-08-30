import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { createDaemonFetchHandler } from "@src/serve.js";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function createTestServices(): { services: Services; cleanup: () => void } {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const root = mkdtempSync(join(tmpdir(), "dream-action-apply-"));
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });

  return {
    services,
    cleanup: (): void => {
      try {
        services.supervisor.stopAll();
      } catch {
        /* ignore shutdown errors in cleanup */
      }
      try {
        db.close();
      } catch {
        /* ignore cleanup errors */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function seedCycle(services: Services, cycleId: string): void {
  services.db
    .prepare(
      `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
       VALUES(?, ?, 'cron', 1.0, 'running', '[]')`,
    )
    .run(cycleId, Date.now());
}

function seedMemory(services: Services, memoryId: string): void {
  const now = new Date().toISOString();
  services.db
    .prepare(
      `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
       VALUES(?, 'system', 'promoted', ?, ?, 'title', 'body', ?, ?)`,
    )
    .run(memoryId, now, now, now, now);
}

function seedAction(
  services: Services,
  opts: {
    actionId: string;
    cycleId: string;
    phase: string;
    actionType: string;
    status: string;
    targetIds: string[];
    payload?: Record<string, unknown>;
  },
): void {
  services.db
    .prepare(
      `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
       VALUES(?, ?, ?, ?, 1.0, ?, ?, ?)`,
    )
    .run(
      opts.actionId,
      opts.cycleId,
      opts.phase,
      opts.actionType,
      opts.status,
      JSON.stringify(opts.targetIds),
      JSON.stringify(opts.payload ?? {}),
    );
}

describe("dream action apply route", () => {
  test("applies queued ephemera_retire and revert restores memory + marks action reverted", async () => {
    const { services, cleanup } = createTestServices();
    try {
      const cycleId = "cycle-apply";
      const memoryId = crypto.randomUUID();
      const actionId = "action-ephemera-queued";

      seedCycle(services, cycleId);
      seedMemory(services, memoryId);
      seedAction(services, {
        actionId,
        cycleId,
        phase: "PC1",
        actionType: "ephemera_retire",
        status: "queued",
        targetIds: [memoryId],
      });

      const handler = createDaemonFetchHandler({ services, token: "tok" });
      const applyRes = await handler(
        new Request("http://x/dreaming/apply", {
          method: "POST",
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({ action_id: actionId }),
        }),
      );
      expect(applyRes.status).toBe(200);

      const actionAfterApply = services.db
        .prepare("SELECT status FROM dream_actions WHERE action_id = ?")
        .get(actionId) as { status: string };
      expect(actionAfterApply.status).toBe("applied");

      const memAfterApply = services.db
        .prepare("SELECT retired_at FROM t2_memories WHERE memory_id = ?")
        .get(memoryId) as { retired_at: number | null };
      expect(memAfterApply.retired_at).not.toBeNull();

      const revertRes = await handler(
        new Request("http://x/dreaming/revert", {
          method: "POST",
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({ action_id: actionId }),
        }),
      );
      expect(revertRes.status).toBe(200);

      const actionAfterRevert = services.db
        .prepare("SELECT status FROM dream_actions WHERE action_id = ?")
        .get(actionId) as { status: string };
      expect(actionAfterRevert.status).toBe("reverted");

      const memAfterRevert = services.db
        .prepare("SELECT retired_at FROM t2_memories WHERE memory_id = ?")
        .get(memoryId) as { retired_at: number | null };
      expect(memAfterRevert.retired_at).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("returns 4xx for non-queued actions", async () => {
    const { services, cleanup } = createTestServices();
    try {
      const cycleId = "cycle-nonqueued";
      const memoryId = crypto.randomUUID();
      const actionId = "action-nonqueued";

      seedCycle(services, cycleId);
      seedMemory(services, memoryId);
      seedAction(services, {
        actionId,
        cycleId,
        phase: "PC1",
        actionType: "ephemera_retire",
        status: "auto_applied",
        targetIds: [memoryId],
      });

      const handler = createDaemonFetchHandler({ services, token: "tok" });
      const applyRes = await handler(
        new Request("http://x/dreaming/apply", {
          method: "POST",
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({ action_id: actionId }),
        }),
      );

      expect(applyRes.status).toBeGreaterThanOrEqual(400);
      expect(applyRes.status).toBeLessThan(500);
    } finally {
      cleanup();
    }
  });

  test("returns 4xx for unknown action type", async () => {
    const { services, cleanup } = createTestServices();
    try {
      const cycleId = "cycle-unknown";
      const memoryId = crypto.randomUUID();
      const actionId = "action-unknown";

      seedCycle(services, cycleId);
      seedMemory(services, memoryId);
      seedAction(services, {
        actionId,
        cycleId,
        phase: "P9",
        actionType: "unknown_apply_type",
        status: "queued",
        targetIds: [memoryId],
      });

      const handler = createDaemonFetchHandler({ services, token: "tok" });
      const applyRes = await handler(
        new Request("http://x/dreaming/apply", {
          method: "POST",
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({ action_id: actionId }),
        }),
      );

      expect(applyRes.status).toBeGreaterThanOrEqual(400);
      expect(applyRes.status).toBeLessThan(500);
    } finally {
      cleanup();
    }
  });

  test("returns 4xx for malformed dream action JSON during revert", async () => {
    const { services, cleanup } = createTestServices();
    try {
      const cycleId = "cycle-malformed";
      const actionId = "action-malformed";

      seedCycle(services, cycleId);
      services.db
        .prepare(
          `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
           VALUES(?, ?, 'P3', 'retire', 1.0, 'auto_applied', 'not json', '{}')`,
        )
        .run(actionId, cycleId);

      const handler = createDaemonFetchHandler({ services, token: "tok" });
      const revertRes = await handler(
        new Request("http://x/dreaming/revert", {
          method: "POST",
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({ action_id: actionId }),
        }),
      );

      expect(revertRes.status).toBeGreaterThanOrEqual(400);
      expect(revertRes.status).toBeLessThan(500);
    } finally {
      cleanup();
    }
  });

  test("returns 400 and does not cascade when revert cascade is invalid", async () => {
    const { services, cleanup } = createTestServices();
    try {
      const cycleId = "cycle-invalid-cascade";
      const parentActionId = "action-parent";
      const dependentActionId = "action-dependent";

      seedCycle(services, cycleId);
      services.db
        .prepare(
          `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
           VALUES(?, ?, 'P3', 'retire', 1.0, 'auto_applied', '["memory-parent"]', '{}')`,
        )
        .run(parentActionId, cycleId);
      services.db
        .prepare(
          `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
           VALUES(?, ?, 'P7', 'reembed', 1.0, 'auto_applied', '["memory-dependent"]', ?)`,
        )
        .run(dependentActionId, cycleId, JSON.stringify({ source_action_id: parentActionId }));

      const handler = createDaemonFetchHandler({ services, token: "tok" });
      const revertRes = await handler(
        new Request("http://x/dreaming/revert", {
          method: "POST",
          headers: {
            authorization: "Bearer tok",
            "content-type": "application/json",
          },
          body: JSON.stringify({ action_id: parentActionId, cascade: "forcex" }),
        }),
      );

      expect(revertRes.status).toBe(400);

      const parentAfter = services.db
        .prepare("SELECT status, reverted_by FROM dream_actions WHERE action_id = ?")
        .get(parentActionId) as { status: string; reverted_by: string | null };
      expect(parentAfter.status).toBe("auto_applied");
      expect(parentAfter.reverted_by).toBeNull();

      const dependentAfter = services.db
        .prepare("SELECT status, reverted_by FROM dream_actions WHERE action_id = ?")
        .get(dependentActionId) as { status: string; reverted_by: string | null };
      expect(dependentAfter.status).toBe("auto_applied");
      expect(dependentAfter.reverted_by).toBeNull();
    } finally {
      cleanup();
    }
  });
});
