import { expect, test, spyOn } from "bun:test";
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createWorkflowRunsRegistry } from "../../src/services/workflow-runs-registry.js";

function freshDb(path: string) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      result_json TEXT,
      error_json TEXT,
      result_spill_path TEXT,
      error_spill_path TEXT,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

test("register returns a fresh id each call", () => {
  let n = 0;
  const registry = createWorkflowRunsRegistry({
    uuid: () => `wfrun-${++n}`,
    clock: () => new Date("2026-04-26T00:00:00Z"),
    db: freshDb(":memory:"),
    storageRoot: tmpdir(),
  });

  expect(registry.register("wf-a", "proj")).toBe("wfrun-1");
  expect(registry.register("wf-a", "proj")).toBe("wfrun-2");
});

test("verify returns the registered info", () => {
  const registry = createWorkflowRunsRegistry({
    uuid: () => "wfrun-1",
    clock: () => new Date("2026-04-26T00:00:00Z"),
    db: freshDb(":memory:"),
    storageRoot: tmpdir(),
  });
  const id = registry.register("wf-a", "proj");
  expect(registry.verify(id!)).toEqual({
    workflow_name: "wf-a",
    project_id: "proj",
    registered_at: new Date("2026-04-26T00:00:00Z").getTime(),
  });
});

test("verify returns null for an unknown id", () => {
  const registry = createWorkflowRunsRegistry({
    uuid: () => "wfrun-1",
    clock: () => new Date("2026-04-26T00:00:00Z"),
    db: freshDb(":memory:"),
    storageRoot: tmpdir(),
  });
  expect(registry.verify("missing")).toBeNull();
});

test("register persists status and results across registry re-instantiation", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfr-"));
  const dbPath = join(root, "db.sqlite");
  try {
    let now = new Date("2026-04-26T00:00:00Z");
    const registry1 = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => now,
      db: freshDb(dbPath),
      storageRoot: root,
    });
    const id = registry1.register("wf-a", "proj");
    expect(id).toBe("wfrun-1");
    await expect(registry1.getStatus("wfrun-1")).resolves.toEqual({
      status: "running",
      started_at: now.getTime(),
    });
    await registry1.recordResult("wfrun-1", { ok: true });

    const registry2 = createWorkflowRunsRegistry({
      uuid: () => "wfrun-2",
      clock: () => now,
      db: freshDb(dbPath),
      storageRoot: root,
    });
    await expect(registry2.getStatus("wfrun-1")).resolves.toEqual({
      status: "completed",
      started_at: now.getTime(),
      finished_at: now.getTime(),
      result: { ok: true },
      persistence_status: "persisted",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("register refuses to evict running runs when capacity is exhausted", () => {
  let n = 0;
  const registry = createWorkflowRunsRegistry({
    uuid: () => `wfrun-${++n}`,
    clock: () => new Date("2026-04-26T00:00:00Z"),
    db: freshDb(":memory:"),
    storageRoot: tmpdir(),
    capacity: 2,
  });
  expect(registry.register("wf-1", "proj")).toBe("wfrun-1");
  expect(registry.register("wf-2", "proj")).toBe("wfrun-2");
  expect(registry.register("wf-3", "proj")).toBeNull();
  expect(registry.verify("wfrun-1")).toEqual({
    workflow_name: "wf-1",
    project_id: "proj",
    registered_at: new Date("2026-04-26T00:00:00Z").getTime(),
  });
});

test("register evicts terminal runs before active runs", async () => {
  let n = 0;
  const registry = createWorkflowRunsRegistry({
    uuid: () => `wfrun-${++n}`,
    clock: () => new Date("2026-04-26T00:00:00Z"),
    db: freshDb(":memory:"),
    storageRoot: tmpdir(),
    capacity: 2,
  });
  const id1 = registry.register("wf-1", "proj");
  const id2 = registry.register("wf-2", "proj");
  await registry.recordResult(id1!, { ok: true });
  expect(registry.register("wf-3", "proj")).toBe("wfrun-3");
  expect(registry.verify(id1!)).toEqual({
    workflow_name: "wf-1",
    project_id: "proj",
    registered_at: new Date("2026-04-26T00:00:00Z").getTime(),
  });
  expect(registry.verify(id2!)).toEqual({
    workflow_name: "wf-2",
    project_id: "proj",
    registered_at: new Date("2026-04-26T00:00:00Z").getTime(),
  });
});

test("waitForResult enforces waiter caps", async () => {
  const registry = createWorkflowRunsRegistry({
    uuid: () => "wfrun-1",
    clock: () => new Date("2026-04-26T00:00:00Z"),
    db: freshDb(":memory:"),
    storageRoot: tmpdir(),
    waiterLimit: 1,
  });
  const id = registry.register("wf-a", "proj");
  const first = registry.waitForResult(id!, 10_000);
  await expect(registry.waitForResult(id!, 10_000)).rejects.toThrow("waiter_capacity_exhausted");
  await registry.recordResult(id!, { ok: true });
  expect(await first).toEqual({
    status: "completed",
    started_at: new Date("2026-04-26T00:00:00Z").getTime(),
    finished_at: new Date("2026-04-26T00:00:00Z").getTime(),
    result: { ok: true },
  });
});

test("verify keeps running runs readable after TTL", async () => {
  let now = new Date("2026-04-26T00:10:01Z");
  const registry = createWorkflowRunsRegistry({
    uuid: () => "wfrun-1",
    clock: () => now,
    db: freshDb(":memory:"),
    storageRoot: tmpdir(),
    ttlMs: 10_000,
  });
  const id = registry.register("wf-a", "proj");
  expect(id).toBe("wfrun-1");
  now = new Date("2026-04-26T00:10:12Z");
  expect(registry.verify("wfrun-1")).toEqual({
    workflow_name: "wf-a",
    project_id: "proj",
    registered_at: new Date("2026-04-26T00:10:01Z").getTime(),
  });
  await expect(registry.getStatus("wfrun-1")).resolves.toEqual({
    status: "running",
    started_at: new Date("2026-04-26T00:10:01Z").getTime(),
  });
});

test("TTL keeps running workflow runs readable and writable after expiry", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfr-ttl-running-"));
  const dbPath = join(root, "db.sqlite");
  try {
    let now = new Date("2026-04-26T00:10:01Z");
    const registry = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => now,
      db: freshDb(dbPath),
      storageRoot: root,
      ttlMs: 10_000,
    });
    const id = registry.register("wf-a", "proj");
    expect(id).toBe("wfrun-1");
    now = new Date("2026-04-26T00:10:12Z");
    await expect(registry.getStatus("wfrun-1")).resolves.toEqual({
      status: "running",
      started_at: new Date("2026-04-26T00:10:01Z").getTime(),
    });
    await registry.recordResult("wfrun-1", { ok: true });
    const row = freshDb(dbPath)
      .query<
        { status: string; completed_at: number | null; result_json: string | null },
        [string]
      >(`SELECT status, completed_at, result_json FROM workflow_runs WHERE id = ?`)
      .get("wfrun-1");
    expect(row).toMatchObject({
      status: "completed",
      completed_at: new Date("2026-04-26T00:10:12Z").getTime(),
    });
    expect(JSON.parse(row?.result_json ?? "null")).toEqual({ ok: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("waitForResult resolves after the in-memory entry is replaced", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfr-wait-race-"));
  const dbPath = join(root, "db.sqlite");
  try {
    const registry = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:10:01Z"),
      db: freshDb(dbPath),
      storageRoot: root,
    });
    const id = registry.register("wf-a", "proj");
    expect(id).toBe("wfrun-1");
    const waiter = registry.waitForResult("wfrun-1", 10_000);
    const registry2 = createWorkflowRunsRegistry({
      uuid: () => "wfrun-2",
      clock: () => new Date("2026-04-26T00:10:01Z"),
      db: freshDb(dbPath),
      storageRoot: root,
    });
    await registry2.recordResult("wfrun-1", { ok: true });
    await expect(waiter).resolves.toEqual({
      status: "completed",
      started_at: new Date("2026-04-26T00:10:01Z").getTime(),
      finished_at: new Date("2026-04-26T00:10:01Z").getTime(),
      result: { ok: true },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("purgeExpiredRows leaves running runs alone after TTL", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfr-ttl-"));
  const dbPath = join(root, "db.sqlite");
  let now = new Date("2026-04-26T00:10:01Z");
  const registry = createWorkflowRunsRegistry({
    uuid: () => "wfrun-1",
    clock: () => now,
    db: freshDb(dbPath),
    storageRoot: root,
    ttlMs: 10_000,
  });
  try {
    const id = registry.register("wf-a", "proj");
    expect(id).toBe("wfrun-1");
    now = new Date("2026-04-26T00:10:12Z");
    expect(registry.verify("wfrun-1")).toEqual({
      workflow_name: "wf-a",
      project_id: "proj",
      registered_at: new Date("2026-04-26T00:10:01Z").getTime(),
    });
    const rows = freshDb(dbPath)
      .query<
        { count: number },
        [string]
      >(`SELECT COUNT(*) AS count FROM workflow_runs WHERE id = ?`)
      .all("wfrun-1");
    expect(rows[0]?.count).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("waitForResult hydrates terminal payloads after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfr-hydrate-"));
  const dbPath = join(root, "db.sqlite");
  try {
    const startedAt = new Date("2026-04-26T00:00:00Z");
    const registry1 = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => startedAt,
      db: freshDb(dbPath),
      storageRoot: root,
    });
    expect(registry1.register("wf-a", "proj")).toBe("wfrun-1");
    await registry1.recordResult("wfrun-1", { ok: true });
    const registry2 = createWorkflowRunsRegistry({
      uuid: () => "wfrun-2",
      clock: () => startedAt,
      db: freshDb(dbPath),
      storageRoot: root,
    });
    await expect(registry2.waitForResult("wfrun-1", 10_000)).resolves.toEqual({
      status: "completed",
      started_at: startedAt.getTime(),
      finished_at: startedAt.getTime(),
      result: { ok: true },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordResult persists large payloads without trusting inline spill envelopes", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfr-spill-"));
  const dbPath = join(root, "db.sqlite");
  try {
    const registry = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db: freshDb(dbPath),
      storageRoot: root,
    });
    const id = registry.register("wf-a", "proj");
    expect(id).toBe("wfrun-1");
    await registry.recordResult("wfrun-1", { __kind: "spill", path: "../../escape" });
    await expect(registry.getStatus("wfrun-1")).resolves.toMatchObject({
      status: "completed",
      started_at: new Date("2026-04-26T00:00:00Z").getTime(),
      finished_at: new Date("2026-04-26T00:00:00Z").getTime(),
      result: { __kind: "spill", path: "../../escape" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordResult stores large payloads only in spill files and nulls the inline column", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfr-spill-null-"));
  const dbPath = join(root, "db.sqlite");
  try {
    const registry = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db: freshDb(dbPath),
      storageRoot: root,
    });
    expect(registry.register("wf-a", "proj")).toBe("wfrun-1");
    const payload = { data: "x".repeat(200_000) };
    await registry.recordResult("wfrun-1", payload);
    const row = freshDb(dbPath)
      .query<
        { result_json: string | null; result_spill_path: string | null },
        [string]
      >(`SELECT result_json, result_spill_path FROM workflow_runs WHERE id = ? LIMIT 1`)
      .get("wfrun-1");
    expect(row).toEqual({ result_json: null, result_spill_path: expect.any(String) });
    const freshRegistry = createWorkflowRunsRegistry({
      uuid: () => "wfrun-2",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db: freshDb(dbPath),
      storageRoot: root,
    });
    await expect(freshRegistry.getStatus("wfrun-1")).resolves.toEqual({
      status: "completed",
      started_at: new Date("2026-04-26T00:00:00Z").getTime(),
      finished_at: new Date("2026-04-26T00:00:00Z").getTime(),
      result: payload,
      persistence_status: "persisted",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readPayload rejects traversal, absolute paths, and symlink escapes", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfr-path-"));
  const outside = mkdtempSync(join(tmpdir(), "wfr-outside-"));
  const dbPath = join(root, "db.sqlite");
  try {
    const registry1 = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db: freshDb(dbPath),
      storageRoot: root,
    });
    expect(registry1.register("wf-a", "proj")).toBe("wfrun-1");
    await registry1.recordResult("wfrun-1", { ok: true });
    const spillPath = join(root, ".penumbra", "workflow-runs", "wfrun-1.json");
    const outsideFile = join(outside, "payload.json");
    writeFileSync(outsideFile, JSON.stringify({ ok: "outside" }));
    const db = freshDb(dbPath);

    db.query(`UPDATE workflow_runs SET result_spill_path = ? WHERE id = ?`).run(
      "../../etc/passwd",
      "wfrun-1",
    );
    await expect(
      createWorkflowRunsRegistry({
        uuid: () => "wfrun-2",
        clock: () => new Date("2026-04-26T00:00:00Z"),
        db: freshDb(dbPath),
        storageRoot: root,
      }).getStatus("wfrun-1"),
    ).resolves.toEqual({
      status: "completed",
      started_at: new Date("2026-04-26T00:00:00Z").getTime(),
      finished_at: new Date("2026-04-26T00:00:00Z").getTime(),
      result: null,
      persistence_status: "persisted",
    });
    db.query(`UPDATE workflow_runs SET result_spill_path = ? WHERE id = ?`).run(
      "/etc/passwd",
      "wfrun-1",
    );
    await expect(
      createWorkflowRunsRegistry({
        uuid: () => "wfrun-3",
        clock: () => new Date("2026-04-26T00:00:00Z"),
        db: freshDb(dbPath),
        storageRoot: root,
      }).getStatus("wfrun-1"),
    ).resolves.toEqual({
      status: "completed",
      started_at: new Date("2026-04-26T00:00:00Z").getTime(),
      finished_at: new Date("2026-04-26T00:00:00Z").getTime(),
      result: null,
      persistence_status: "persisted",
    });
    const realpathSpy = spyOn(fsPromises, "realpath").mockImplementation(async (path: string) => {
      if (path === root) return root;
      if (path === join(root, ".penumbra", "workflow-runs", "escape.json")) return outsideFile;
      return path;
    });
    db.query(`UPDATE workflow_runs SET result_spill_path = ? WHERE id = ?`).run(
      join(".penumbra", "workflow-runs", "escape.json"),
      "wfrun-1",
    );
    await expect(
      createWorkflowRunsRegistry({
        uuid: () => "wfrun-4",
        clock: () => new Date("2026-04-26T00:00:00Z"),
        db: freshDb(dbPath),
        storageRoot: root,
      }).getStatus("wfrun-1"),
    ).resolves.toEqual({
      status: "completed",
      started_at: new Date("2026-04-26T00:00:00Z").getTime(),
      finished_at: new Date("2026-04-26T00:00:00Z").getTime(),
      result: null,
      persistence_status: "persisted",
    });
    realpathSpy.mockRestore();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("recordResult falls back to inline error when spill writing fails and releases waiters", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfr-spill-fail-"));
  const dbPath = join(root, "db.sqlite");
  try {
    const registry = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db: freshDb(dbPath),
      storageRoot: root,
    });
    expect(registry.register("wf-a", "proj")).toBe("wfrun-1");
    const waiter = registry.waitForResult("wfrun-1", 10_000);
    const writeSpy = spyOn(fsPromises, "writeFile").mockImplementationOnce(async () => {
      throw new Error("disk full");
    });
    await registry.recordResult("wfrun-1", { data: "x".repeat(200_000) });
    await expect(waiter).resolves.toEqual({
      status: "failed",
      started_at: new Date("2026-04-26T00:00:00Z").getTime(),
      finished_at: new Date("2026-04-26T00:00:00Z").getTime(),
      error: expect.anything(),
    });
    const row = freshDb(dbPath)
      .query<
        {
          error_json: string | null;
          error_spill_path: string | null;
          result_spill_path: string | null;
        },
        [string]
      >(
        `SELECT error_json, error_spill_path, result_spill_path FROM workflow_runs WHERE id = ? LIMIT 1`,
      )
      .get("wfrun-1");
    expect(row?.error_json).not.toBeNull();
    expect(row?.error_spill_path).toBeNull();
    expect(row?.result_spill_path).toBeNull();
    writeSpy.mockRestore();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordResult yields before the spill write completes and persists the result", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfr-smoke-"));
  const dbPath = join(root, "db.sqlite");
  try {
    const registry = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db: freshDb(dbPath),
      storageRoot: root,
    });
    const id = registry.register("wf-a", "proj");
    expect(id).toBe("wfrun-1");
    const payload = { data: "x".repeat(200_000) };
    const started = performance.now();
    const writePromise = registry.recordResult("wfrun-1", payload);
    await Promise.resolve();
    expect(performance.now() - started).toBeLessThan(10);
    await writePromise;
    await expect(registry.getStatus("wfrun-1")).resolves.toMatchObject({
      status: "completed",
      started_at: new Date("2026-04-26T00:00:00Z").getTime(),
      finished_at: new Date("2026-04-26T00:00:00Z").getTime(),
      result: payload,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
