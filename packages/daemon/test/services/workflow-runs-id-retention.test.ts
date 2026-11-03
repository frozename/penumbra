import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkflowRunsRegistry } from "@src/services/workflow-runs-registry.js";

type IdFixture = {
  registry: ReturnType<typeof createWorkflowRunsRegistry>;
  db: Database;
  root: string;
  close(): void;
  advance(milliseconds: number): void;
  localIds(): number;
  rows(): number;
};

function fixture(capacity = 2, ttlMs = 1_000): IdFixture {
  const root = mkdtempSync(join(tmpdir(), "wfr-local-ids-"));
  const db = new Database(":memory:");
  db.run(`CREATE TABLE workflow_runs (
    id TEXT PRIMARY KEY, project_id TEXT, workflow_name TEXT NOT NULL,
    status TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER,
    result_json TEXT, error_json TEXT, result_spill_path TEXT, error_spill_path TEXT,
    result_bytes INTEGER NOT NULL DEFAULT 0, error_bytes INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL
  )`);
  const prefix = crypto.randomUUID().slice(0, 24);
  let now = 1_000_000;
  let sequence = 0;
  let identities: WeakRef<Set<unknown>> | undefined;
  const add = Object.getOwnPropertyDescriptor(Set.prototype, "add")!.value as (
    this: Set<unknown>,
    value: unknown,
  ) => Set<unknown>;
  const tracker = spyOn(Set.prototype, "add").mockImplementation(function (
    this: Set<unknown>,
    value: unknown,
  ) {
    if (typeof value === "string" && value.startsWith(prefix)) {
      if (identities && identities.deref() !== this)
        throw new Error("unexpected identity Set receiver");
      identities ??= new WeakRef(this);
    }
    return add.call(this, value);
  });
  const close = (): void => {
    tracker.mockRestore();
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  try {
    const registry = createWorkflowRunsRegistry({
      uuid: () => prefix + String(++sequence).padStart(12, "0"),
      clock: () => new Date(now),
      db,
      storageRoot: root,
      capacity,
      ttlMs,
    });
    return {
      registry,
      db,
      root,
      close,
      advance: (milliseconds: number): void => {
        now += milliseconds;
      },
      localIds: (): number => identities?.deref()?.size ?? 0,
      rows: (): number =>
        db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM workflow_runs").get()!.n,
    };
  } catch (error) {
    close();
    throw error;
  }
}

test("10,000 successful unregister cycles release local workflow identities", () => {
  const f = fixture();
  try {
    for (let cycle = 0; cycle < 10_000; cycle++) {
      const id = f.registry.register("unregister", null)!;
      f.registry.unregister(id);
    }
    expect(f.rows()).toBe(0);
    expect(f.localIds()).toBe(0);
  } finally {
    f.close();
  }
});

test("terminal expiry releases identities after durable rows are purged", async () => {
  const f = fixture(2, 1);
  try {
    for (let cycle = 0; cycle < 100; cycle++) {
      const id = f.registry.register("expire", null)!;
      await f.registry.recordResult(id, { ok: true });
      f.advance(2);
      expect(await f.registry.getStatus("unknown")).toBeNull();
    }
    expect(f.rows()).toBe(0);
    expect(f.localIds()).toBe(0);
  } finally {
    f.close();
  }
});

test("register-only completed workloads perform durable terminal expiry", async () => {
  const f = fixture(2, 1);
  try {
    for (let cycle = 0; cycle < 100; cycle++) {
      const id = f.registry.register("register-only", null)!;
      await f.registry.recordResult(id, { ok: true });
      f.advance(2);
    }
    const running = f.registry.register("trigger-expiry", null)!;
    expect(f.rows()).toBe(1);
    expect(f.localIds()).toBe(1);
    f.registry.unregister(running);
    expect(f.localIds()).toBe(0);
  } finally {
    f.close();
  }
});

test("lightweight status expires completed rows and identity state", async () => {
  const f = fixture(2, 1);
  try {
    const id = f.registry.register("light-only", null)!;
    await f.registry.recordResult(id, { ok: true });
    f.advance(2);
    expect(await f.registry.getStatusLight(id)).toBeNull();
    expect(f.rows()).toBe(0);
    expect(f.localIds()).toBe(0);
  } finally {
    f.close();
  }
});

for (const failedPersistence of [false, true]) {
  test(`capacity eviction preserves local provenance after ${failedPersistence ? "failed" : "successful"} persistence`, async () => {
    const f = fixture(1);
    try {
      if (failedPersistence) writeFileSync(join(f.root, ".penumbra"), "blocks spill directory");
      const id = f.registry.register("capacity", null)!;
      await f.registry.recordResult(
        id,
        failedPersistence ? { data: "x".repeat(70_000) } : { ok: true },
      );
      expect(await f.registry.getStatus(id)).toHaveProperty(
        "persistence_status",
        failedPersistence ? "persistence_failed" : "persisted",
      );
      const running = f.registry.register("evict-cache", null)!;
      expect((await f.registry.getStatus(id))?.status).toBe(
        failedPersistence ? "failed" : "completed",
      );
      expect(await f.registry.getStatus(id)).not.toHaveProperty("persistence_status");
      expect(f.localIds()).toBe(2);
      f.registry.unregister(id);
      f.registry.unregister(running);
      expect(f.rows()).toBe(0);
      expect(f.localIds()).toBe(0);
    } finally {
      f.close();
    }
  });
}

test("late completion survives registration cache expiry until completion TTL", async () => {
  const f = fixture();
  try {
    const id = f.registry.register("late-completion", null)!;
    f.advance(1_100);
    await f.registry.recordResult(id, { late: true });
    const status = await f.registry.getStatus(id);
    expect(status?.status).toBe("completed");
    expect(status).toHaveProperty("result", { late: true });
    expect(status).not.toHaveProperty("persistence_status");
    expect(f.localIds()).toBe(1);
    f.advance(1_001);
    expect(await f.registry.getStatusLight(id)).toBeNull();
    expect(f.localIds()).toBe(0);
  } finally {
    f.close();
  }
});

test("failed unregister deletion keeps local provenance until deletion succeeds", async () => {
  const f = fixture();
  try {
    const id = f.registry.register("delete-refused", null)!;
    await f.registry.recordResult(id, { ok: true });
    f.db.run(
      "CREATE TRIGGER prevent_delete BEFORE DELETE ON workflow_runs BEGIN SELECT RAISE(ABORT,'delete refused'); END",
    );
    expect(() => {
      f.registry.unregister(id);
    }).toThrow("delete refused");
    expect(f.rows()).toBe(1);
    expect(f.localIds()).toBe(1);
    expect(await f.registry.getStatus(id)).not.toHaveProperty("persistence_status");
    f.db.run("DROP TRIGGER prevent_delete");
    f.registry.unregister(id);
    expect(f.localIds()).toBe(0);
  } finally {
    f.close();
  }
});

test("failed terminal purge keeps local identities until durable deletion succeeds", async () => {
  const f = fixture(2, 1);
  try {
    const id = f.registry.register("purge-refused", null)!;
    await f.registry.recordResult(id, { ok: true });
    f.advance(2);
    f.db.run(
      "CREATE TRIGGER prevent_delete BEFORE DELETE ON workflow_runs BEGIN SELECT RAISE(ABORT,'purge refused'); END",
    );
    const failure = await f.registry.getStatus(id).catch((error: unknown) => error);
    expect(failure).toHaveProperty("message", "purge refused");
    expect(f.rows()).toBe(1);
    expect(f.localIds()).toBe(1);
    f.db.run("DROP TRIGGER prevent_delete");
    expect(await f.registry.getStatusLight(id)).toBeNull();
    expect(f.localIds()).toBe(0);
  } finally {
    f.close();
  }
});

test("light status expiry preserves running ownership and live waiter delivery", async () => {
  const f = fixture(2, 1);
  try {
    const id = f.registry.register("long-running", null)!;
    const waiter = f.registry.waitForResult(id, 1_000);
    f.advance(100);
    expect((await f.registry.getStatusLight(id))?.status).toBe("running");
    expect(f.rows()).toBe(1);
    expect(f.localIds()).toBe(1);
    await f.registry.recordResult(id, { late: true });
    expect(await waiter).toHaveProperty("result", { late: true });
    expect(await f.registry.getStatus(id)).toHaveProperty("result", { late: true });
  } finally {
    f.close();
  }
});

test("an ignored unregister DELETE does not release local provenance", async () => {
  const f = fixture();
  try {
    const id = f.registry.register("ignored-delete", null)!;
    await f.registry.recordResult(id, { ok: true });
    f.db.run(
      "CREATE TRIGGER ignore_delete BEFORE DELETE ON workflow_runs BEGIN SELECT RAISE(IGNORE); END",
    );
    f.registry.unregister(id);
    expect(f.rows()).toBe(1);
    expect(f.localIds()).toBe(1);
    expect(await f.registry.getStatus(id)).not.toHaveProperty("persistence_status");
    f.db.run("DROP TRIGGER ignore_delete");
    f.registry.unregister(id);
    expect(f.localIds()).toBe(0);
  } finally {
    f.close();
  }
});

test("an ignored terminal purge keeps identities for surviving durable rows", async () => {
  const f = fixture(2, 1);
  try {
    const id = f.registry.register("ignored-purge", null)!;
    await f.registry.recordResult(id, { ok: true });
    f.advance(2);
    f.db.run(
      "CREATE TRIGGER ignore_delete BEFORE DELETE ON workflow_runs BEGIN SELECT RAISE(IGNORE); END",
    );
    await f.registry.getStatus(id);
    expect(f.rows()).toBe(1);
    expect(f.localIds()).toBe(1);
    f.db.run("DROP TRIGGER ignore_delete");
    expect(await f.registry.getStatusLight(id)).toBeNull();
    expect(f.localIds()).toBe(0);
  } finally {
    f.close();
  }
});

test("light expiry keeps a live waiter while terminal persistence is pending", async () => {
  const f = fixture(2, 1);
  try {
    const id = f.registry.register("pending-terminal", null)!;
    const waiting = f.registry.waitForResult(id, 50);
    f.advance(100);
    f.registry.setExecutionRecord(id, {
      status: "completed",
      started_at: 1_000_000,
      finished_at: 1_000_100,
      result: { ok: true },
    });
    f.registry.setPersistenceStatus(id, "pending");
    expect((await f.registry.getStatusLight(id))?.status).toBe("running");
    await f.registry.recordResult(id, { ok: true });
    expect(await waiting).toHaveProperty("result", { ok: true });
    f.advance(2);
    expect(await f.registry.getStatusLight(id)).toBeNull();
    expect(f.localIds()).toBe(0);
  } finally {
    f.close();
  }
});
