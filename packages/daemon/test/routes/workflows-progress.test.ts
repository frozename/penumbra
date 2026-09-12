import { loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { buildRegistry } from "@penumbra/workflows";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workflowsRunRoute } from "@src/routes/workflows.js";
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
  return { ...partial, log: noopLog } as unknown as Services;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

const PROGRESS_WORKFLOW = `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'progress-check',
  description: 'records a native progress event',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn: WorkflowFn = async (ctx) => {
  ctx.progress!('hello from native workflow', { step: 1 });
  return { ok: true };
};
`;

async function setup(root: string): Promise<{ services: Services; db: Database }> {
  writeFileSync(join(root, ".penumbra-project"), "test-project\n");
  mkdirSync(join(root, "playbooks"), { recursive: true });
  mkdirSync(join(root, "workflows/progress-check"), { recursive: true });
  writeFileSync(join(root, "workflows/progress-check/workflow.ts"), PROGRESS_WORKFLOW);
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
  return {
    services: mockServices({
      workflowRegistry: reg,
      workflowRuns,
      db,
      storageRoot: root,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    }),
    db,
  };
}

async function runWorkflow(opts: {
  services: Services;
  root: string;
  name: string;
  wait?: boolean;
  args?: Record<string, unknown>;
}): Promise<Response> {
  return await workflowsRunRoute(
    new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: opts.name,
        cwd: opts.root,
        ...(opts.wait === undefined ? {} : { wait: opts.wait }),
        ...(opts.args === undefined ? {} : { args: opts.args }),
      }),
    }),
    opts.services,
  );
}

test("workflow run records a progress t0 event with the run id and default execution identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-route-progress-"));
  const priorHostname = process.env.HOSTNAME;
  process.env.HOSTNAME = "route-test-machine";
  try {
    const { services, db } = await setup(root);
    const res = await runWorkflow({ services, root, name: "progress-check", wait: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workflow_run_id?: string;
      outcome?: string;
    };
    expect(body.outcome).toBe("success");
    expect(body.workflow_run_id).toBe("wfrun-1");

    const rows = db
      .query("SELECT * FROM t0_events WHERE event_type = 'workflow.progress'")
      .all() as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    const row = rows[0];
    if (row === undefined) throw new Error("expected one workflow progress event");
    expect(row.event_type).toBe("workflow.progress");
    expect(row.project_id).toBe("test-project");
    expect(row.session_id).toBe("daemon-direct");
    expect(row.user_id).toBe("penumbra");
    expect(row.machine_id).toBe("route-test-machine");
    expect(row.source).toBe("agentchat");
    expect(row.lane).toBe("local");
    expect(row.provider).toBeNull();
    expect(row.model).toBeNull();
    expect(row.tokens_in).toBeNull();
    expect(row.tokens_out).toBeNull();
    expect(row.cost_usd).toBeNull();
    expect(row.latency_ms).toBeNull();
    expect(row.request_id).toBeNull();

    const payload = JSON.parse(row.payload_json as string) as Record<string, unknown>;
    expect(payload.workflow_run_id).toBe("wfrun-1");
    expect(payload.message).toBe("hello from native workflow");
    expect(payload.meta).toEqual({ step: 1 });
    expect(row.payload_summary).toBe("hello from native workflow");
  } finally {
    if (priorHostname === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = priorHostname;
    rmSync(root, { recursive: true, force: true });
  }
});
