import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkflowRunsRegistry } from "@src/services/workflow-runs-registry.js";

function fixture(): {
  registry: ReturnType<typeof createWorkflowRunsRegistry>;
  close: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "wfr-retention-"));
  const db = new Database(":memory:");
  db.run(`CREATE TABLE workflow_runs (
    id TEXT PRIMARY KEY, project_id TEXT, workflow_name TEXT NOT NULL,
    status TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER,
    result_json TEXT, error_json TEXT, result_spill_path TEXT, error_spill_path TEXT,
    result_bytes INTEGER NOT NULL DEFAULT 0, error_bytes INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL
  )`);
  let sequence = 0;
  return {
    registry: createWorkflowRunsRegistry({
      uuid: () => `run-${String(++sequence)}`,
      clock: () => new Date("2026-10-31T00:00:00Z"),
      db,
      storageRoot: root,
    }),
    close: (): void => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function collect(): Promise<void> {
  // WeakRef targets stay alive until the current job ends.
  await Bun.sleep(0);
  Bun.gc(true);
  await Bun.sleep(0);
  Bun.gc(true);
}

for (const kind of ["result", "error"] as const) {
  test(`persisted workflow ${kind} retention stays bounded after 100 waiter deliveries`, async () => {
    const { registry, close } = fixture();
    const persist =
      kind === "result"
        ? registry.recordResult.bind(registry)
        : registry.recordError.bind(registry);
    try {
      const refs = await (async (): Promise<WeakRef<object>[]> => {
        const targets: WeakRef<object>[] = [];
        for (let cycle = 0; cycle < 100; cycle++) {
          const id = registry.register("retention", null)!;
          const payload = {
            values: Array.from({ length: 20_000 }, (_, index) => index + cycle),
          };
          targets.push(new WeakRef(payload));
          const waiter = registry.waitForResult(id, 1_000);
          registry.setExecutionRecord(id, {
            status: kind === "result" ? "completed" : "failed",
            started_at: Date.now(),
            [kind]: payload,
          });
          await persist(id, payload);
          expect((await waiter)?.[kind] === payload).toBe(true);
        }
        return targets;
      })();
      await collect();
      // JSC can conservatively retain the last loop temporaries after a full collection.
      expect(refs.filter((ref) => ref.deref() !== undefined).length).toBeLessThanOrEqual(2);
      const reloaded = await registry.getStatus("run-1");
      expect(reloaded?.status).toBe(kind === "result" ? "completed" : "failed");
      expect(reloaded?.[kind]).toHaveProperty("values");
    } finally {
      close();
    }
  });

  test(`reading persisted workflow ${kind} payloads does not retain hydrated objects`, async () => {
    const { registry, close } = fixture();
    try {
      const id = registry.register("retention", null)!;
      if (kind === "result") await registry.recordResult(id, { data: "x".repeat(100_000) });
      else await registry.recordError(id, { data: "x".repeat(100_000) });
      const refs = await (async (): Promise<WeakRef<object>[]> => {
        const status = await registry.getStatus(id);
        const waited = await registry.waitForResult(id, 1_000);
        expect(status?.[kind]).toEqual({ data: "x".repeat(100_000) });
        expect(waited?.[kind]).toEqual(status?.[kind]);
        return [new WeakRef(status![kind] as object), new WeakRef(waited![kind] as object)];
      })();
      await collect();
      expect(refs.filter((ref) => ref.deref() !== undefined).length).toBe(0);
      expect((await registry.getStatus(id))?.[kind]).toEqual({ data: "x".repeat(100_000) });
    } finally {
      close();
    }
  });
}
