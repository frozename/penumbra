import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { createWorkflowRunsRegistry } from "@src/services/workflow-runs-registry.js";

function freshDb(path: string): Database {
  const db = new Database(path);
  db.run(`
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
      result_bytes INTEGER NOT NULL DEFAULT 0,
      error_bytes INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

async function expectResolvesEqual<T>(promise: Promise<T>, expected: unknown): Promise<void> {
  expect(await promise).toEqual(expected);
}

async function expectResolvesMatchObject<T>(promise: Promise<T>, expected: object): Promise<void> {
  expect(await promise).toMatchObject(expected);
}

async function expectResolvesNull<T>(promise: Promise<T | null>): Promise<void> {
  expect(await promise).toBeNull();
}

async function expectRejectsWith(
  promise: Promise<unknown>,
  expected: string | RegExp,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (typeof expected === "string") {
      expect(message).toContain(expected);
    } else {
      expect(message).toMatch(expected);
    }
    return;
  }
  throw new Error("expected promise to reject but it resolved");
}

class SpillWriteError extends Error {
  readonly code = "disk_full";

  toJSON(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}

test("register returns a fresh id each call", () => {
  let n = 0;
  const registry = createWorkflowRunsRegistry({
    uuid: () => `wfrun-${String(++n)}`,
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
    const now = new Date("2026-04-26T00:00:00Z");
    const registry1 = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => now,
      db: freshDb(dbPath),
      storageRoot: root,
    });
    const id = registry1.register("wf-a", "proj");
    expect(id).toBe("wfrun-1");
    await expectResolvesEqual(registry1.getStatus("wfrun-1"), {
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
    await expectResolvesEqual(registry2.getStatus("wfrun-1"), {
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

test("getStatusLight returns result_available + result_bytes and omits the result payload", async () => {
  const now = new Date("2026-04-26T00:00:00Z");
  const registry = createWorkflowRunsRegistry({
    uuid: () => "wfrun-1",
    clock: () => now,
    db: freshDb(":memory:"),
    storageRoot: tmpdir(),
  });
  expect(registry.register("wf-a", "proj")).toBe("wfrun-1");
  const result = { ok: true, nested: { value: 1 } };
  const expectedBytes = Buffer.byteLength(JSON.stringify(result));
  await registry.recordResult("wfrun-1", result);

  const status = await registry.getStatusLight("wfrun-1");
  expect(status).toEqual({
    status: "completed",
    started_at: now.getTime(),
    finished_at: now.getTime(),
    result_available: true,
    result_bytes: expectedBytes,
    error_bytes: 0,
  });
  expect(status).not.toHaveProperty("result");
  expect(status).not.toHaveProperty("error");
});

test("getStatusLight reports a running run without a result", async () => {
  const now = new Date("2026-04-26T00:00:00Z");
  const registry = createWorkflowRunsRegistry({
    uuid: () => "wfrun-1",
    clock: () => now,
    db: freshDb(":memory:"),
    storageRoot: tmpdir(),
  });
  expect(registry.register("wf-a", "proj")).toBe("wfrun-1");

  await expectResolvesEqual(registry.getStatusLight("wfrun-1"), {
    status: "running",
    started_at: now.getTime(),
    result_available: false,
    result_bytes: 0,
    error_bytes: 0,
  });
});

test("getStatusLight keeps result_available true for completed null payloads", async () => {
  const now = new Date("2026-04-26T00:00:00Z");
  const registry = createWorkflowRunsRegistry({
    uuid: () => "wfrun-1",
    clock: () => now,
    db: freshDb(":memory:"),
    storageRoot: tmpdir(),
  });
  expect(registry.register("wf-a", "proj")).toBe("wfrun-1");
  await registry.recordResult("wfrun-1", null);

  await expectResolvesEqual(registry.getStatusLight("wfrun-1"), {
    status: "completed",
    started_at: now.getTime(),
    finished_at: now.getTime(),
    result_available: true,
    result_bytes: Buffer.byteLength("null"),
    error_bytes: 0,
  });
});

test("recordResult/recordError persist result_bytes/error_bytes matching serialized payload size", async () => {
  const now = new Date("2026-04-26T00:00:00Z");
  const db = freshDb(":memory:");
  const registry = createWorkflowRunsRegistry({
    uuid: (() => {
      let n = 0;
      return (): string => `wfrun-${String(++n)}`;
    })(),
    clock: () => now,
    db,
    storageRoot: tmpdir(),
  });

  expect(registry.register("wf-result", "proj")).toBe("wfrun-1");
  const resultPayload = { ok: true, values: [1, 2, 3] };
  await registry.recordResult("wfrun-1", resultPayload);

  expect(registry.register("wf-error", "proj")).toBe("wfrun-2");
  const errorPayload = { code: "boom", detail: "something failed" };
  await registry.recordError("wfrun-2", errorPayload);

  await expectResolvesMatchObject(registry.getStatusLight("wfrun-1"), {
    result_bytes: Buffer.byteLength(JSON.stringify(resultPayload)),
    error_bytes: 0,
    result_available: true,
  });
  await expectResolvesMatchObject(registry.getStatusLight("wfrun-2"), {
    result_bytes: 0,
    error_bytes: Buffer.byteLength(JSON.stringify(errorPayload)),
    result_available: false,
  });
});

test("register refuses to evict running runs when capacity is exhausted", () => {
  let n = 0;
  const registry = createWorkflowRunsRegistry({
    uuid: () => `wfrun-${String(++n)}`,
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
    uuid: () => `wfrun-${String(++n)}`,
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

test("register sweeps expired terminal runs before checking capacity", async () => {
  let now = new Date("2026-04-26T00:00:00Z");
  let n = 0;
  const registry = createWorkflowRunsRegistry({
    uuid: () => `wfrun-${String(++n)}`,
    clock: () => now,
    db: freshDb(":memory:"),
    storageRoot: tmpdir(),
    capacity: 2,
    ttlMs: 1_000,
  });

  const id1 = registry.register("wf-1", "proj");
  const id2 = registry.register("wf-2", "proj");
  expect(id1).toBe("wfrun-1");
  expect(id2).toBe("wfrun-2");
  await registry.recordResult(id1!, { ok: true });
  await registry.recordResult(id2!, { ok: true });

  now = new Date("2026-04-26T00:00:02Z");
  expect(registry.register("wf-3", "proj")).toBe("wfrun-3");
  expect(registry.verify(id1!)).toBeNull();
  expect(registry.verify(id2!)).toBeNull();
});

test("evictIfNeeded drains all expired terminal runs in one pass", async () => {
  let now = new Date("2026-04-26T00:00:00Z");
  let n = 0;
  const registry = createWorkflowRunsRegistry({
    uuid: () => `wfrun-${String(++n)}`,
    clock: () => now,
    db: freshDb(":memory:"),
    storageRoot: tmpdir(),
    capacity: 2,
    ttlMs: 1_000,
  });

  const id1 = registry.register("wf-1", "proj");
  const id2 = registry.register("wf-2", "proj");
  expect(id1).toBe("wfrun-1");
  expect(id2).toBe("wfrun-2");
  await registry.recordResult(id1!, { ok: true });
  await registry.recordError(id2!, { ok: false });

  now = new Date("2026-04-26T00:00:02Z");
  expect(registry.register("wf-3", "proj")).toBe("wfrun-3");
  expect(registry.register("wf-4", "proj")).toBe("wfrun-4");
});

test("capacity-pressure eviction clears persistence state alongside the entry", async () => {
  let n = 0;
  const registry = createWorkflowRunsRegistry({
    uuid: () => `wfrun-evict-orphan-${String(++n)}`,
    clock: () => new Date("2026-04-26T00:00:00Z"),
    db: freshDb(":memory:"),
    storageRoot: tmpdir(),
    capacity: 2,
  });
  const id1 = registry.register("wf-1", "proj");
  const id2 = registry.register("wf-2", "proj");
  expect(id1).toBe("wfrun-evict-orphan-1");
  expect(id2).toBe("wfrun-evict-orphan-2");
  await registry.recordResult(id1!, { ok: true });
  await registry.recordResult(id2!, { ok: true });

  await expectResolvesMatchObject(registry.getStatus(id1!), {
    persistence_status: "persisted",
  });

  expect(registry.register("wf-3", "proj")).toBe("wfrun-evict-orphan-3");

  const status = await registry.getStatus(id1!);
  expect(status).not.toBeNull();
  expect(status).not.toHaveProperty("persistence_status");
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
  await expectRejectsWith(registry.waitForResult(id!, 10_000), "waiter_capacity_exhausted");
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
  await expectResolvesEqual(registry.getStatus("wfrun-1"), {
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
    await expectResolvesEqual(registry.getStatus("wfrun-1"), {
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

test("terminal workflow runs keep their result through the retention window and are later purged", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfr-ttl-terminal-"));
  const dbPath = join(root, "db.sqlite");
  try {
    let now = new Date("2026-04-26T00:10:00Z");
    let n = 0;
    const registry = createWorkflowRunsRegistry({
      uuid: () => `wfrun-${String(++n)}`,
      clock: () => now,
      db: freshDb(dbPath),
      storageRoot: root,
      ttlMs: 10_000,
    });

    expect(registry.register("wf-a", "proj")).toBe("wfrun-1");
    now = new Date("2026-04-26T00:10:18Z");
    await registry.recordResult("wfrun-1", { ok: true });

    await expectResolvesMatchObject(registry.getStatus("wfrun-1"), {
      status: "completed",
      started_at: new Date("2026-04-26T00:10:00Z").getTime(),
      finished_at: new Date("2026-04-26T00:10:18Z").getTime(),
      result: { ok: true },
    });
    await expectResolvesEqual(registry.waitForResult("wfrun-1", 10), {
      status: "completed",
      started_at: new Date("2026-04-26T00:10:00Z").getTime(),
      finished_at: new Date("2026-04-26T00:10:18Z").getTime(),
      result: { ok: true },
    });

    now = new Date("2026-04-26T00:10:27Z");
    const refreshedRow = freshDb(dbPath)
      .query<
        { expires_at: number; completed_at: number | null },
        [string]
      >(`SELECT expires_at, completed_at FROM workflow_runs WHERE id = ?`)
      .get("wfrun-1");
    expect(refreshedRow).toEqual({
      expires_at: new Date("2026-04-26T00:10:28Z").getTime(),
      completed_at: new Date("2026-04-26T00:10:18Z").getTime(),
    });
    await expectResolvesMatchObject(registry.getStatus("wfrun-1"), {
      status: "completed",
      started_at: new Date("2026-04-26T00:10:00Z").getTime(),
      finished_at: new Date("2026-04-26T00:10:18Z").getTime(),
      result: { ok: true },
    });

    now = new Date("2026-04-26T00:10:29Z");
    expect(registry.register("wf-b", "proj")).toBe("wfrun-2");
    expect(registry.verify("wfrun-1")).toBeNull();
    await expectResolvesNull(registry.getStatus("wfrun-1"));
    await expectResolvesNull(registry.waitForResult("wfrun-1", 10));
    const row = freshDb(dbPath)
      .query<
        { count: number },
        [string]
      >(`SELECT COUNT(*) AS count FROM workflow_runs WHERE id = ?`)
      .get("wfrun-1");
    expect(row?.count).toBe(0);
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
    await expectResolvesEqual(waiter, {
      status: "completed",
      started_at: new Date("2026-04-26T00:10:01Z").getTime(),
      finished_at: new Date("2026-04-26T00:10:01Z").getTime(),
      result: { ok: true },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("purgeExpiredRows leaves running runs alone after TTL", () => {
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
    await expectResolvesEqual(registry2.waitForResult("wfrun-1", 10_000), {
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
    await expectResolvesMatchObject(registry.getStatus("wfrun-1"), {
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
    const expectedBytes = Buffer.byteLength(JSON.stringify(payload));
    await registry.recordResult("wfrun-1", payload);
    const row = freshDb(dbPath)
      .query<
        { result_json: string | null; result_spill_path: string | null },
        [string]
      >(`SELECT result_json, result_spill_path FROM workflow_runs WHERE id = ? LIMIT 1`)
      .get("wfrun-1");
    expect(row?.result_json).toBeNull();
    expect(typeof row?.result_spill_path).toBe("string");
    const light = await registry.getStatusLight("wfrun-1");
    expect(light?.result_bytes).toBe(expectedBytes);
    expect(light?.result_bytes).toBeGreaterThan(0);
    const freshRegistry = createWorkflowRunsRegistry({
      uuid: () => "wfrun-2",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db: freshDb(dbPath),
      storageRoot: root,
    });
    await expectResolvesEqual(freshRegistry.getStatus("wfrun-1"), {
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

test("recordError stores large payloads only in spill files and tracks error_bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfr-spill-error-"));
  const dbPath = join(root, "db.sqlite");
  try {
    const registry = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db: freshDb(dbPath),
      storageRoot: root,
    });
    expect(registry.register("wf-a", "proj")).toBe("wfrun-1");
    const errorPayload = { detail: "x".repeat(200_000) };
    const expectedBytes = Buffer.byteLength(JSON.stringify(errorPayload));
    await registry.recordError("wfrun-1", errorPayload);
    const row = freshDb(dbPath)
      .query<
        { error_json: string | null; error_spill_path: string | null },
        [string]
      >(`SELECT error_json, error_spill_path FROM workflow_runs WHERE id = ? LIMIT 1`)
      .get("wfrun-1");
    expect(row?.error_json).toBeNull();
    expect(typeof row?.error_spill_path).toBe("string");
    const light = await registry.getStatusLight("wfrun-1");
    expect(light?.result_available).toBe(false);
    expect(light?.error_bytes).toBe(expectedBytes);
    expect(light?.error_bytes).toBeGreaterThan(0);
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
    await expectResolvesEqual(
      createWorkflowRunsRegistry({
        uuid: () => "wfrun-2",
        clock: () => new Date("2026-04-26T00:00:00Z"),
        db: freshDb(dbPath),
        storageRoot: root,
      }).getStatus("wfrun-1"),
      {
        status: "completed",
        started_at: new Date("2026-04-26T00:00:00Z").getTime(),
        finished_at: new Date("2026-04-26T00:00:00Z").getTime(),
        result: null,
        persistence_status: "persisted",
      },
    );
    db.query(`UPDATE workflow_runs SET result_spill_path = ? WHERE id = ?`).run(
      "/etc/passwd",
      "wfrun-1",
    );
    await expectResolvesEqual(
      createWorkflowRunsRegistry({
        uuid: () => "wfrun-3",
        clock: () => new Date("2026-04-26T00:00:00Z"),
        db: freshDb(dbPath),
        storageRoot: root,
      }).getStatus("wfrun-1"),
      {
        status: "completed",
        started_at: new Date("2026-04-26T00:00:00Z").getTime(),
        finished_at: new Date("2026-04-26T00:00:00Z").getTime(),
        result: null,
        persistence_status: "persisted",
      },
    );
    const realpathSpy = spyOn(fsPromises, "realpath").mockImplementation((path: string) => {
      if (path === root) return root;
      if (path === join(root, ".penumbra", "workflow-runs", "escape.json")) return outsideFile;
      return Promise.resolve(path);
    });
    db.query(`UPDATE workflow_runs SET result_spill_path = ? WHERE id = ?`).run(
      join(".penumbra", "workflow-runs", "escape.json"),
      "wfrun-1",
    );
    await expectResolvesEqual(
      createWorkflowRunsRegistry({
        uuid: () => "wfrun-4",
        clock: () => new Date("2026-04-26T00:00:00Z"),
        db: freshDb(dbPath),
        storageRoot: root,
      }).getStatus("wfrun-1"),
      {
        status: "completed",
        started_at: new Date("2026-04-26T00:00:00Z").getTime(),
        finished_at: new Date("2026-04-26T00:00:00Z").getTime(),
        result: null,
        persistence_status: "persisted",
      },
    );
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
    const spillWriteError = new SpillWriteError("disk full");
    const expectedErrorBytes = Buffer.byteLength(JSON.stringify(spillWriteError));
    const writeSpy = spyOn(fsPromises, "writeFile").mockImplementationOnce(() =>
      Promise.reject(spillWriteError),
    );
    await registry.recordResult("wfrun-1", { data: "x".repeat(200_000) });
    const waitResult = await waiter;
    expect(waitResult).toMatchObject({
      status: "failed",
      started_at: new Date("2026-04-26T00:00:00Z").getTime(),
      finished_at: new Date("2026-04-26T00:00:00Z").getTime(),
    });
    expect(waitResult?.error).toBeTruthy();
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
    expect(row?.error_json).toBe(JSON.stringify(spillWriteError));
    expect(row?.error_spill_path).toBeNull();
    expect(row?.result_spill_path).toBeNull();
    const light = await registry.getStatusLight("wfrun-1");
    expect(light?.error_bytes).toBe(expectedErrorBytes);
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
    await expectResolvesMatchObject(registry.getStatus("wfrun-1"), {
      status: "completed",
      started_at: new Date("2026-04-26T00:00:00Z").getTime(),
      finished_at: new Date("2026-04-26T00:00:00Z").getTime(),
      result: payload,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000, stepMs = 10): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  if (!predicate()) throw new Error("waitFor: predicate never became true");
}

test("purgeExpiredRows unlinks spill files when purging expired terminal rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfr-purge-spill-"));
  const dbPath = join(root, "db.sqlite");
  try {
    let now = new Date("2026-04-26T00:00:00Z");
    let n = 0;
    const registry = createWorkflowRunsRegistry({
      uuid: () => `wfrun-${String(++n)}`,
      clock: () => now,
      db: freshDb(dbPath),
      storageRoot: root,
      ttlMs: 1_000,
    });
    expect(registry.register("wf-a", "proj")).toBe("wfrun-1");
    const largePayload = { data: "x".repeat(200_000) };
    await registry.recordResult("wfrun-1", largePayload);
    const spillPath = join(root, ".penumbra", "workflow-runs", "wfrun-1.json");
    expect(existsSync(spillPath)).toBe(true);

    now = new Date("2026-04-26T00:10:00Z");
    await registry.getStatus("wfrun-1");

    await waitFor(() => !existsSync(spillPath));
    expect(existsSync(spillPath)).toBe(false);

    const dbRow = freshDb(dbPath)
      .query<
        { count: number },
        [string]
      >(`SELECT COUNT(*) AS count FROM workflow_runs WHERE id = ?`)
      .get("wfrun-1");
    expect(dbRow?.count).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("boot sweep unlinks orphan spill files whose workflow_runs rows are gone", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfr-boot-sweep-"));
  const dbPath = join(root, "db.sqlite");
  try {
    const spillDir = join(root, ".penumbra", "workflow-runs");
    mkdirSync(spillDir, { recursive: true });
    const orphanPath = join(spillDir, "wfrun-orphan.json");
    writeFileSync(orphanPath, JSON.stringify({ orphan: true }));

    createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db: freshDb(dbPath),
      storageRoot: root,
    });

    await waitFor(() => !existsSync(orphanPath));
    expect(existsSync(orphanPath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("boot sweep leaves spill files whose workflow_runs rows still exist", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfr-boot-keep-"));
  const dbPath = join(root, "db.sqlite");
  try {
    const registry = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db: freshDb(dbPath),
      storageRoot: root,
    });
    expect(registry.register("wf-a", "proj")).toBe("wfrun-1");
    await registry.recordResult("wfrun-1", { data: "x".repeat(200_000) });
    const spillPath = join(root, ".penumbra", "workflow-runs", "wfrun-1.json");
    expect(existsSync(spillPath)).toBe(true);

    createWorkflowRunsRegistry({
      uuid: () => "wfrun-2",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db: freshDb(dbPath),
      storageRoot: root,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(spillPath)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
