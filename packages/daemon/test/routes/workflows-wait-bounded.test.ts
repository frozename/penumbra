import { ProjectRegistry, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { workflowsWaitRoute } from "@src/routes/workflows.js";
import { createWorkflowRunsRegistry } from "@src/services/workflow-runs-registry.js";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // Optional Homebrew SQLite is unavailable in some CI images.
  }
}

function freshDb(): Database {
  const db = new Database(":memory:");
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

function markTrustedRoot(root: string): void {
  writeFileSync(join(root, ".penumbra-project"), "proj-a\n");
}

function makeServices(
  root: string,
  db: Database,
  workflowRuns: ReturnType<typeof createWorkflowRunsRegistry>,
): Services {
  // workflowsWaitRoute reads only this route-local subset of daemon services.
  return {
    workflowRuns,
    projectRegistry: new ProjectRegistry(
      new Map([["proj-a", { project_id: "proj-a", root_path: root }]]),
    ),
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    settings: { storageRoot: root },
  } as unknown as Services;
}

test("POST /workflows/wait returns full result inline even when oversized", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-wait-cap-result-"));
  try {
    markTrustedRoot(root);
    const db = freshDb();
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-05-29T00:00:00Z"),
      db,
      storageRoot: root,
    });
    expect(workflowRuns.register("wf", "proj-a")).toBe("wfrun-1");

    const largeResult = { payload: "😀".repeat(20_000) };
    const totalBytes = Buffer.byteLength(JSON.stringify(largeResult));
    await workflowRuns.recordResult("wfrun-1", largeResult);

    const req = new Request("http://localhost/workflows/wait", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-1", timeout_ms: 10, cwd: root }),
    });
    const res = await workflowsWaitRoute(req, makeServices(root, db, workflowRuns));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.status).toBe("completed");
    expect(body.result).toEqual(largeResult);
    expect(body.result_bytes).toBe(totalBytes);
    expect(body.error_bytes).toBe(0);
    expect("result_truncated" in body).toBe(false);
    expect("result_preview" in body).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/wait returns the full result when below the limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-wait-small-result-"));
  try {
    markTrustedRoot(root);
    const db = freshDb();
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-05-29T00:00:00Z"),
      db,
      storageRoot: root,
    });
    expect(workflowRuns.register("wf", "proj-a")).toBe("wfrun-1");

    const result = { ok: true, note: "small result" };
    const totalBytes = Buffer.byteLength(JSON.stringify(result));
    await workflowRuns.recordResult("wfrun-1", result);

    const req = new Request("http://localhost/workflows/wait", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-1", timeout_ms: 10, cwd: root }),
    });
    const res = await workflowsWaitRoute(req, makeServices(root, db, workflowRuns));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.result).toEqual(result);
    expect(body.result_bytes).toBe(totalBytes);
    expect(body.error_bytes).toBe(0);
    expect("result_truncated" in body).toBe(false);
    expect("result_preview" in body).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/wait always includes result_bytes on a terminal response", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-wait-result-bytes-"));
  try {
    markTrustedRoot(root);
    const db = freshDb();
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-05-29T00:00:00Z"),
      db,
      storageRoot: root,
    });
    expect(workflowRuns.register("wf", "proj-a")).toBe("wfrun-1");
    const result = { done: true };
    await workflowRuns.recordResult("wfrun-1", result);

    const req = new Request("http://localhost/workflows/wait", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-1", timeout_ms: 10, cwd: root }),
    });
    const res = await workflowsWaitRoute(req, makeServices(root, db, workflowRuns));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.status).toBe("completed");
    expect("result_bytes" in body).toBe(true);
    expect(typeof body.result_bytes).toBe("number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/wait returns full error inline even when oversized", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-wait-cap-error-"));
  try {
    markTrustedRoot(root);
    const db = freshDb();
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-05-29T00:00:00Z"),
      db,
      storageRoot: root,
    });
    expect(workflowRuns.register("wf", "proj-a")).toBe("wfrun-1");

    const largeError = { reason: "🔥".repeat(20_000) };
    const totalBytes = Buffer.byteLength(JSON.stringify(largeError));
    await workflowRuns.recordError("wfrun-1", largeError);

    const req = new Request("http://localhost/workflows/wait", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-1", timeout_ms: 10, cwd: root }),
    });
    const res = await workflowsWaitRoute(req, makeServices(root, db, workflowRuns));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.status).toBe("failed");
    expect(body.error).toEqual(largeError);
    expect(body.error_bytes).toBe(totalBytes);
    expect(body.result_bytes).toBe(0);
    expect("error_truncated" in body).toBe(false);
    expect("error_preview" in body).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/wait returns escape-heavy oversized result inline", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-wait-escape-heavy-"));
  try {
    markTrustedRoot(root);
    const db = freshDb();
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-05-29T00:00:00Z"),
      db,
      storageRoot: root,
    });
    expect(workflowRuns.register("wf", "proj-a")).toBe("wfrun-1");

    const escapeDenseChunk = '"\\\\\\n'.repeat(20_000);
    const largeResult = { payload: escapeDenseChunk };
    await workflowRuns.recordResult("wfrun-1", largeResult);

    const req = new Request("http://localhost/workflows/wait", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-1", timeout_ms: 10, cwd: root }),
    });
    const res = await workflowsWaitRoute(req, makeServices(root, db, workflowRuns));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.result).toEqual(largeResult);
    expect("result_truncated" in body).toBe(false);
    expect("result_preview" in body).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/wait leaves the timeout branch unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-wait-timeout-"));
  try {
    markTrustedRoot(root);
    const db = freshDb();
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-05-29T00:00:00Z"),
      db,
      storageRoot: root,
    });
    expect(workflowRuns.register("wf", "proj-a")).toBe("wfrun-1");

    const req = new Request("http://localhost/workflows/wait", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-1", timeout_ms: 5, cwd: root }),
    });
    const res = await workflowsWaitRoute(req, makeServices(root, db, workflowRuns));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "timeout" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
