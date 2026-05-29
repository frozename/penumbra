import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ProjectRegistry } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { WORKFLOW_WAIT_PAYLOAD_LIMIT, workflowsWaitRoute } from "../../src/routes/workflows.js";
import { createWorkflowRunsRegistry } from "../../src/services/workflow-runs-registry.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {}
}

function freshDb() {
  const db = new Database(":memory:");
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
      result_bytes INTEGER NOT NULL DEFAULT 0,
      error_bytes INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

function markTrustedRoot(root: string) {
  writeFileSync(join(root, ".penumbra-project"), "proj-a\n");
}

function makeServices(
  root: string,
  db: Database,
  workflowRuns: ReturnType<typeof createWorkflowRunsRegistry>,
) {
  return {
    workflowRuns,
    projectRegistry: new ProjectRegistry(
      new Map([["proj-a", { project_id: "proj-a", root_path: root }]]),
    ),
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    settings: { storageRoot: root },
  } as any;
}

test("POST /workflows/wait truncates a result larger than the limit", async () => {
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
    const marker = `…[truncated — ${totalBytes} bytes total; full payload not inlined]`;

    expect(res.status).toBe(200);
    expect(body.status).toBe("completed");
    expect(body.result).toBeNull();
    expect(body.result_truncated).toBe(true);
    expect(body.result_bytes).toBe(totalBytes);
    expect(body.error_bytes).toBe(0);
    expect(typeof body.result_preview).toBe("string");
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(
      WORKFLOW_WAIT_PAYLOAD_LIMIT,
    );
    expect((body.result_preview as string).endsWith(marker)).toBe(true);
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
    expect(body.result_truncated).toBe(false);
    expect(body.result).toEqual(result);
    expect(body.result_bytes).toBe(totalBytes);
    expect(body.error_bytes).toBe(0);
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

test("POST /workflows/wait truncates an oversized error symmetrically", async () => {
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
    const marker = `…[truncated — ${totalBytes} bytes total; full payload not inlined]`;

    expect(res.status).toBe(200);
    expect(body.status).toBe("failed");
    expect(body.error).toBeNull();
    expect(body.error_truncated).toBe(true);
    expect(body.error_bytes).toBe(totalBytes);
    expect(body.result_bytes).toBe(0);
    expect(typeof body.error_preview).toBe("string");
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(
      WORKFLOW_WAIT_PAYLOAD_LIMIT,
    );
    expect((body.error_preview as string).endsWith(marker)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/wait keeps response bounded for escape-heavy oversized payloads", async () => {
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
    expect(body.result).toBeNull();
    expect(body.result_truncated).toBe(true);
    expect(typeof body.result_preview).toBe("string");
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(
      WORKFLOW_WAIT_PAYLOAD_LIMIT,
    );
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
