import { loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { buildRegistry } from "@penumbra/workflows";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workflowsRunRoute, workflowsWaitRoute } from "@src/routes/workflows.js";
import { createWorkflowRunsRegistry } from "@src/services/workflow-runs-registry.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // bundled sqlite is fine
  }
}

function mockServices(partial: Record<string, unknown>): Services {
  const noopLog = {
    error: (): undefined => undefined,
    warn: (): undefined => undefined,
    info: (): undefined => undefined,
    debug: (): undefined => undefined,
    trace: (): undefined => undefined,
    fatal: (): undefined => undefined,
  };
  return { ...partial, log: noopLog } as Services;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

const THROWING_WORKFLOW = `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'exploder',
  description: 'throws on purpose',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn: WorkflowFn = () => Promise.reject(new Error('worker exploded'));
`;

test("a run_error outcome persists workflow_runs.status='failed', not 'completed'", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-outcome-status-"));
  try {
    writeFileSync(join(root, ".penumbra-project"), "test-project\n");
    mkdirSync(join(root, "playbooks"), { recursive: true });
    mkdirSync(join(root, "workflows/exploder"), { recursive: true });
    writeFileSync(join(root, "workflows/exploder/workflow.ts"), THROWING_WORKFLOW);

    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const db = freshDb();
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db,
      storageRoot: root,
    });
    const services = mockServices({
      workflowRegistry: reg,
      workflowRuns,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
      projectRegistry: undefined,
    });

    const res = await workflowsRunRoute(
      new Request("http://localhost/workflows/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "exploder", cwd: root, wait: true }),
      }),
      services,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome?: string; errorMessage?: string };
    expect(body.outcome).toBe("run_error");
    expect(body.errorMessage).toContain("worker exploded");

    const light = await workflowRuns.getStatusLight("wfrun-1");
    expect(light?.status).toBe("failed");
    expect(light?.result_available).toBe(false);

    const waitRes = await workflowsWaitRoute(
      new Request("http://localhost/workflows/wait", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow_run_id: "wfrun-1", timeout_ms: 50, cwd: root }),
      }),
      services,
    );
    const waitBody = (await waitRes.json()) as { status?: string; outcome?: string };
    expect(waitBody.status).toBe("failed");
    expect(waitBody.outcome).toBe("run_error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
