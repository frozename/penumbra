import {
  buildServices,
  type ExtractStumblesInput,
  loadSqliteVec,
  migrate,
  ProjectRegistry,
  type Services,
  TaskDraftPayloadSchema,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { composeRecall } from "@penumbra/workflows";
import { buildRegistry, type Registry } from "@penumbra/workflows";
import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bootPickupMeta,
  fileSessionSummarizeStumbles,
  MAX_DRAFTS_PER_SESSION,
  workflowsHistoryRoute,
  workflowsListRoute,
  workflowsRunRoute,
  workflowsStatusRoute,
  workflowsSuggestRoute,
  workflowsTriggerRoute,
  workflowsWaitRoute,
} from "@src/routes/workflows.js";
import { createWorkflowRunsRegistry } from "@src/services/workflow-runs-registry.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // sqlite override unavailable; fall back to bundled
  }
}

function mockServices(partial: Record<string, unknown>): Services {
  // Tests stub only the Services properties each route reads. A fully typed
  // mock would require constructing every runtime singleton (writers, registry,
  // embedder, ...); centralize the type gap here so callers stay readable.
  const noopLog = {
    error: (): undefined => undefined,
    warn: (): undefined => undefined,
    info: (): undefined => undefined,
    debug: (): undefined => undefined,
    trace: (): undefined => undefined,
    fatal: (): undefined => undefined,
  };
  const partialLog =
    typeof partial.log === "object" && partial.log !== null
      ? (partial.log as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown> = { ...partial, log: { ...noopLog, ...partialLog } };
  return merged as Services;
}

function mockRegistry(partial: Record<string, unknown>): Registry {
  const opaque: unknown = partial;
  return opaque as Registry;
}

function execMulti(db: Database, sql: string): void {
  // Database.exec is deprecated; split multi-statement SQL into per-statement
  // db.run calls so each statement is prepared via the supported API.
  for (const stmt of sql
    .split(";")
    .map((stmt) => stmt.trim())
    .filter(Boolean)) {
    db.run(stmt);
  }
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function markTrustedRoot(root: string): void {
  writeFileSync(join(root, ".penumbra-project"), "test-project\n");
}

function hermeticServiceDirs(root: string): { worktreeRootDir: string; mainRepoDir: string } {
  const worktreeRootDir = join(root, "worktrees");
  const mainRepoDir = join(root, "main");
  mkdirSync(worktreeRootDir, { recursive: true });
  mkdirSync(mainRepoDir, { recursive: true });
  writeFileSync(join(mainRepoDir, "package.json"), "{}\n");
  return { worktreeRootDir, mainRepoDir };
}

test("buildServices tolerates a seeded worktree root over the route test DB", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-worktree-root-"));
  try {
    const { worktreeRootDir, mainRepoDir } = hermeticServiceDirs(root);
    const handoffId = "11111111-2222-4333-8444-555555555555";
    const wt = join(worktreeRootDir, handoffId);
    mkdirSync(wt, { recursive: true });
    const gitDir = join(root, "gitdir");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/agent/${handoffId}\n`);

    const services = buildServices({
      env: {},
      input: {},
      storageRoot: root,
      db: freshDb(),
      embedder: new TestEmbedder({ dim: 384 }),
      worktreeRootDir,
      mainRepoDir,
    });

    expect(services.worktreeManager.listWorktrees().map((h) => h.branchName)).toEqual([
      `agent/${handoffId}`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function setupReg(): Promise<{ reg: Registry; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "wfd-"));
  markTrustedRoot(root);
  mkdirSync(join(root, "playbooks/x"), { recursive: true });
  mkdirSync(join(root, "workflows"), { recursive: true });
  writeFileSync(
    join(root, "playbooks/x/playbook.md"),
    `---\nname: x\ndescription: D\ntriggers:\n  - kind: manual\nrecall: []\noutput:\n  - kind: clipboard\nrun:\n  kind: markdown-template\n---\nbody\n`,
  );
  const reg = await buildRegistry({
    playbooksDir: join(root, "playbooks"),
    workflowsDir: join(root, "workflows"),
  });
  return { reg, root };
}

test("GET /workflows/list returns registry list", async () => {
  const { reg, root } = await setupReg();
  try {
    const services = mockServices({ workflowRegistry: reg });
    const req = new Request("http://localhost/workflows/list");
    const res = await workflowsListRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflows: { name: string; description: string }[] };
    expect(body.workflows.map((w) => w.name)).toEqual(["x"]);
    expect(body.workflows[0].description).toBe("D");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/run executes a registered workflow", async () => {
  const { reg, root } = await setupReg();
  try {
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
    });
    const req = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", wait: true }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string; composedPrompt: string };
    expect(body.outcome).toBe("success");
    expect(body.composedPrompt).toContain("body");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/run with wait:true returns the full workflow result inline", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-wait-"));
  try {
    markTrustedRoot(root);
    mkdirSync(join(root, "playbooks"), { recursive: true });
    mkdirSync(join(root, "workflows/waited"), { recursive: true });
    writeFileSync(
      join(root, "workflows/waited/workflow.ts"),
      `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'waited',
  description: 'waited result',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn: WorkflowFn = async () => ({ outcome: 'sync', nested: { ok: true } });
`,
    );
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
    });
    const req = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "waited", cwd: root, wait: true }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcome?: string;
      runResult?: { outcome?: string; nested?: { ok?: boolean } };
    };
    expect(body.outcome).toBe("success");
    expect(body.runResult).toMatchObject({ outcome: "sync", nested: { ok: true } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/run with wait:true returns the real result even when persistence fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-wait-persistfail-"));
  try {
    markTrustedRoot(root);
    mkdirSync(join(root, "playbooks"), { recursive: true });
    mkdirSync(join(root, "workflows/waitedfail"), { recursive: true });
    writeFileSync(
      join(root, "workflows/waitedfail/workflow.ts"),
      `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'waitedfail',
  description: 'waited fail',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn: WorkflowFn = async () => ({ outcome: 'sync', payload: { real: true } });
`,
    );
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const db = freshDb();
    const persistenceStatuses: string[] = [];
    let recordErrorCalls = 0;
    let recordResultCalls = 0;
    const workflowRuns = {
      register: (): string => "wfrun-persistfail",
      verify: (): { workflow_name: string; project_id: string | null; registered_at: number } => ({
        workflow_name: "waitedfail",
        project_id: null,
        registered_at: 0,
      }),
      unregister: (): void => undefined,
      recordResult: (): Promise<void> => {
        recordResultCalls += 1;
        throw new Error("no such table: workflow_runs");
      },
      recordError: (): Promise<void> => {
        recordErrorCalls += 1;
      },
      getStatus: (): Promise<null> => null,
      getStatusLight: (): Promise<null> => null,
      waitForResult: (): Promise<null> => null,
      setPersistenceStatus: (
        _id: string,
        status: "pending" | "persisted" | "persistence_failed",
      ): void => {
        persistenceStatuses.push(status);
      },
      setExecutionRecord: (): void => undefined,
    };
    const services = mockServices({
      workflowRegistry: reg,
      workflowRuns,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "waitedfail", cwd: root, wait: true }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcome?: string;
      runResult?: { outcome?: string; payload?: { real?: boolean } };
    };
    expect(body.outcome).toBe("success");
    expect(body.runResult).toMatchObject({ outcome: "sync", payload: { real: true } });
    expect(recordResultCalls).toBe(1);
    expect(persistenceStatuses).toContain("persistence_failed");
    expect(recordErrorCalls).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/run returns workflow_run_id immediately when wait is omitted, and status becomes completed later", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-async-"));
  try {
    markTrustedRoot(root);
    mkdirSync(join(root, "playbooks"), { recursive: true });
    mkdirSync(join(root, "workflows/delay"), { recursive: true });
    writeFileSync(
      join(root, "workflows/delay/workflow.ts"),
      `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'delay',
  description: 'async delay',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn: WorkflowFn = async () => {
  await new Promise((resolve) => setTimeout(resolve, 25));
  return { outcome: 'done' };
};
`,
    );
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
    });
    const req = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "delay", cwd: root }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workflow_run_id: "wfrun-1",
      started_at: expect.any(Number) as unknown,
    });
    let statusBody: { status: string } | null = null;
    for (let i = 0; i < 20; i += 1) {
      const statusReq = new Request("http://localhost/workflows/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow_run_id: "wfrun-1", cwd: root }),
      });
      const statusRes = await workflowsStatusRoute(statusReq, services);
      statusBody = (await statusRes.json()) as { status: string };
      if (statusBody.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(statusBody?.status).toBe("completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/run logs detached persistence failures instead of surfacing them as unhandled rejections", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-detached-fail-"));
  try {
    markTrustedRoot(root);
    mkdirSync(join(root, "playbooks"), { recursive: true });
    mkdirSync(join(root, "workflows/detached"), { recursive: true });
    writeFileSync(
      join(root, "workflows/detached/workflow.ts"),
      `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'detached',
  description: 'detached run',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn: WorkflowFn = async () => ({ ok: true });
`,
    );
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
    const log = {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    } as const;
    const errorSpy = spyOn(log, "error");
    const services = mockServices({
      workflowRegistry: reg,
      workflowRuns,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
      log,
    });
    const recordSpy = spyOn(workflowRuns, "recordResult").mockRejectedValueOnce(
      new Error("persist failed"),
    );
    const req = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "detached", cwd: root }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recordSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/status stays bounded when recordResult rejects outright (run stays running)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-detached-status-"));
  try {
    markTrustedRoot(root);
    mkdirSync(join(root, "playbooks"), { recursive: true });
    mkdirSync(join(root, "workflows/detached-status"), { recursive: true });
    writeFileSync(
      join(root, "workflows/detached-status/workflow.ts"),
      `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'detached-status',
  description: 'detached status',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn: WorkflowFn = async () => ({ ok: true });
`,
    );
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
    });
    const recordSpy = spyOn(workflowRuns, "recordResult").mockRejectedValueOnce(
      new Error("persist failed"),
    );
    const runReq = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "detached-status", cwd: root }),
    });
    const runRes = await workflowsRunRoute(runReq, services);
    expect(runRes.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // This test forces recordResult to reject, bypassing recordResult's internal
    // persistence-failure try/catch. Real writePayload failures are caught there
    // and transition the DB row to failed; this asserts the forced-rejection edge case.
    expect(recordSpy).toHaveBeenCalled();
    const statusReq = new Request("http://localhost/workflows/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-1", cwd: root }),
    });
    const statusRes = await workflowsStatusRoute(statusReq, services);
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as Record<string, unknown>;
    expect(status).toMatchObject({
      status: "running",
      result_available: false,
      result_bytes: 0,
      error_bytes: 0,
    });
    expect("persistence_status" in status).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/run redacts stack traces from persistence failure logs by default", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-redact-"));
  try {
    markTrustedRoot(root);
    mkdirSync(join(root, "playbooks"), { recursive: true });
    mkdirSync(join(root, "workflows/redact"), { recursive: true });
    writeFileSync(
      join(root, "workflows/redact/workflow.ts"),
      `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'redact',
  description: 'redact stack',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn: WorkflowFn = async () => ({ ok: true });
`,
    );
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
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const services = mockServices({
      workflowRegistry: reg,
      workflowRuns,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
      log: {
        error: (...args: unknown[]) => {
          console.error(args.map(String).join(" "));
        },
      },
    });
    spyOn(workflowRuns, "recordResult").mockRejectedValueOnce(new Error("persist failed"));
    const runReq = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "redact", cwd: root }),
    });
    const runRes = await workflowsRunRoute(runReq, services);
    expect(runRes.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const logged = errorSpy.mock.calls.flat().map(String).join("\n");
    expect(logged).not.toContain("Error: persist failed");
    expect(logged).not.toContain("at ");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/wait blocks until terminal state and times out", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-wait-"));
  try {
    markTrustedRoot(root);
    const db = freshDb();
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db,
      storageRoot: root,
    });
    const id = workflowRuns.register("wf", "proj");
    expect(id).toBe("wfrun-1");
    const services = mockServices({
      workflowRuns,
      projectRegistry: new ProjectRegistry(
        new Map([["proj", { project_id: "proj", root_path: root }]]),
      ),
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    await workflowRuns.recordResult("wfrun-1", { ok: true });
    const successReq = new Request("http://localhost/workflows/wait", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-1", timeout_ms: 100, cwd: root }),
    });
    const successRes = await workflowsWaitRoute(successReq, services);
    expect(await successRes.json()).toMatchObject({
      status: "completed",
      started_at: expect.any(Number) as unknown,
      finished_at: expect.any(Number) as unknown,
      result: { ok: true },
      result_bytes: expect.any(Number) as unknown,
      error_bytes: 0,
    });

    const timeoutReq = new Request("http://localhost/workflows/wait", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-2", timeout_ms: 5, cwd: root }),
    });
    const timeoutDb = freshDb();
    const timeoutRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-2",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db: timeoutDb,
      storageRoot: root,
    });
    expect(timeoutRuns.register("wf-timeout", "proj")).toBe("wfrun-2");
    const timeoutServices = mockServices({
      workflowRuns: timeoutRuns,
      projectRegistry: new ProjectRegistry(
        new Map([["proj", { project_id: "proj", root_path: root }]]),
      ),
      db: timeoutDb,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const timeoutRes = await workflowsWaitRoute(timeoutReq, timeoutServices);
    expect(await timeoutRes.json()).toEqual({ status: "timeout" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/wait accepts timeout_ms up to 1.8M and rejects beyond", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-wait-cap-"));
  try {
    markTrustedRoot(root);
    const db = freshDb();
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-cap",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db,
      storageRoot: root,
    });
    workflowRuns.register("wf", "proj");
    await workflowRuns.recordResult("wfrun-cap", { ok: true });
    const services = mockServices({
      workflowRuns,
      projectRegistry: new ProjectRegistry(
        new Map([["proj", { project_id: "proj", root_path: root }]]),
      ),
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });

    const okReq = new Request("http://localhost/workflows/wait", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-cap", timeout_ms: 1_800_000, cwd: root }),
    });
    const okRes = await workflowsWaitRoute(okReq, services);
    expect(okRes.status).toBe(200);

    const tooLargeReq = new Request("http://localhost/workflows/wait", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-cap", timeout_ms: 1_800_001, cwd: root }),
    });
    const tooLargeRes = await workflowsWaitRoute(tooLargeReq, services);
    expect(tooLargeRes.status).toBe(400);
    expect(await tooLargeRes.json()).toEqual({
      error: { code: "invalid_args", message: "timeout_ms must be between 1 and 1800000" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/wait returns not_found for unknown ids", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-wait-missing-"));
  try {
    markTrustedRoot(root);
    const db = freshDb();
    const services = mockServices({
      workflowRuns: createWorkflowRunsRegistry({
        uuid: () => "wfrun-1",
        clock: () => new Date("2026-04-26T00:00:00Z"),
        db,
        storageRoot: root,
      }),
      projectRegistry: new ProjectRegistry(
        new Map([["proj-a", { project_id: "proj-a", root_path: root }]]),
      ),
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/wait", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "missing", cwd: root, timeout_ms: 10 }),
    });
    const res = await workflowsWaitRoute(req, services);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "workflow run not found" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/status rejects cross-project access with not_found shape", async () => {
  const root1 = mkdtempSync(join(tmpdir(), "wf-auth-a-"));
  const root2 = mkdtempSync(join(tmpdir(), "wf-auth-b-"));
  try {
    markTrustedRoot(root1);
    markTrustedRoot(root2);
    const db = freshDb();
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db,
      storageRoot: root1,
    });
    const id = workflowRuns.register("wf", "proj-a");
    expect(id).toBe("wfrun-1");
    const services = mockServices({
      workflowRuns,
      projectRegistry: new ProjectRegistry(
        new Map([
          ["proj-a", { project_id: "proj-a", root_path: root1 }],
          ["proj-b", { project_id: "proj-b", root_path: root2 }],
        ]),
      ),
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root1 },
    });

    const forbiddenReq = new Request("http://localhost/workflows/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-1", cwd: root2 }),
    });
    const forbiddenRes = await workflowsStatusRoute(forbiddenReq, services);
    expect(forbiddenRes.status).toBe(404);
    expect(await forbiddenRes.json()).toEqual({
      error: { code: "not_found", message: "workflow run not found" },
    });

    const allowedReq = new Request("http://localhost/workflows/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-1", cwd: root1 }),
    });
    const allowedRes = await workflowsStatusRoute(allowedReq, services);
    expect(allowedRes.status).toBe(200);
  } finally {
    rmSync(root1, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

test("POST /workflows/status omits result and error fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-status-omits-payload-"));
  try {
    markTrustedRoot(root);
    const db = freshDb();
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db,
      storageRoot: root,
    });
    expect(workflowRuns.register("wf", "proj-a")).toBe("wfrun-1");
    const largeResult = { data: "x".repeat(100_000) };
    await workflowRuns.recordResult("wfrun-1", largeResult);
    const services = mockServices({
      workflowRuns,
      projectRegistry: new ProjectRegistry(
        new Map([["proj-a", { project_id: "proj-a", root_path: root }]]),
      ),
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });

    const req = new Request("http://localhost/workflows/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-1", cwd: root }),
    });
    const res = await workflowsStatusRoute(req, services);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect("result" in body).toBe(false);
    expect("error" in body).toBe(false);
    expect(body.status).toBe("completed");
    expect(body.result_available).toBe(true);
    expect(Number(body.result_bytes)).toBeGreaterThan(90_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/status body is < 2 KB regardless of result size", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-status-bound-size-"));
  try {
    markTrustedRoot(root);
    const db = freshDb();
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db,
      storageRoot: root,
    });
    expect(workflowRuns.register("wf", "proj-a")).toBe("wfrun-1");
    await workflowRuns.recordResult("wfrun-1", { data: "x".repeat(100_000) });
    const services = mockServices({
      workflowRuns,
      projectRegistry: new ProjectRegistry(
        new Map([["proj-a", { project_id: "proj-a", root_path: root }]]),
      ),
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });

    const req = new Request("http://localhost/workflows/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-1", cwd: root }),
    });
    const res = await workflowsStatusRoute(req, services);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(2048);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/status uses getStatusLight, not getStatus", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-status-light-path-"));
  try {
    markTrustedRoot(root);
    const db = freshDb();
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db,
      storageRoot: root,
    });
    expect(workflowRuns.register("wf", "proj-a")).toBe("wfrun-1");
    const getStatusLightSpy = spyOn(workflowRuns, "getStatusLight");
    const getStatusSpy = spyOn(workflowRuns, "getStatus");
    const services = mockServices({
      workflowRuns,
      projectRegistry: new ProjectRegistry(
        new Map([["proj-a", { project_id: "proj-a", root_path: root }]]),
      ),
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });

    const req = new Request("http://localhost/workflows/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-1", cwd: root }),
    });
    const res = await workflowsStatusRoute(req, services);
    expect(res.status).toBe(200);
    expect(getStatusLightSpy).toHaveBeenCalledWith("wfrun-1");
    expect(getStatusSpy).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/status returns 200 (not 400 untrusted_cwd) for a same-project run", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-status-same-project-"));
  try {
    markTrustedRoot(root);
    const db = freshDb();
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db,
      storageRoot: root,
    });
    expect(workflowRuns.register("wf", "proj-a")).toBe("wfrun-1");
    const services = mockServices({
      workflowRuns,
      projectRegistry: new ProjectRegistry(
        new Map([["proj-a", { project_id: "proj-a", root_path: root }]]),
      ),
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });

    const req = new Request("http://localhost/workflows/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-1", cwd: root }),
    });
    const res = await workflowsStatusRoute(req, services);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(res.status).toBe(200);
    expect(body.error?.code).not.toBe("untrusted_cwd");
    expect(body).toMatchObject({
      status: "running",
      started_at: expect.any(Number) as unknown,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/status returns the same not_found response for unknown and foreign ids", async () => {
  const root1 = mkdtempSync(join(tmpdir(), "wf-auth-c-"));
  const root2 = mkdtempSync(join(tmpdir(), "wf-auth-d-"));
  try {
    markTrustedRoot(root1);
    markTrustedRoot(root2);
    const db = freshDb();
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db,
      storageRoot: root1,
    });
    workflowRuns.register("wf", "proj-a");
    const services = mockServices({
      workflowRuns,
      projectRegistry: new ProjectRegistry(
        new Map([
          ["proj-a", { project_id: "proj-a", root_path: root1 }],
          ["proj-b", { project_id: "proj-b", root_path: root2 }],
        ]),
      ),
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root1 },
    });

    const foreignReq = new Request("http://localhost/workflows/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-1", cwd: root2 }),
    });
    const unknownReq = new Request("http://localhost/workflows/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "missing", cwd: root1 }),
    });

    const foreignRes = await workflowsStatusRoute(foreignReq, services);
    const unknownRes = await workflowsStatusRoute(unknownReq, services);

    expect(foreignRes.status).toBe(404);
    expect(unknownRes.status).toBe(404);
    expect(await foreignRes.json()).toEqual(await unknownRes.json());
  } finally {
    rmSync(root1, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

test("POST /workflows/status returns explicit not_found for unknown ids", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-unknown-"));
  try {
    markTrustedRoot(root);
    const db = freshDb();
    const services = mockServices({
      workflowRuns: createWorkflowRunsRegistry({
        uuid: () => "wfrun-1",
        clock: () => new Date("2026-04-26T00:00:00Z"),
        db,
        storageRoot: root,
      }),
      projectRegistry: new ProjectRegistry(
        new Map([["proj-a", { project_id: "proj-a", root_path: root }]]),
      ),
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "missing", cwd: root }),
    });
    const res = await workflowsStatusRoute(req, services);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "workflow run not found" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootPickupMeta drops unserializable first-moves meta and emits a warning", () => {
  const warnings: Record<string, unknown>[] = [];
  const meta = bootPickupMeta(
    { count: 1n },
    {
      warn: (fields: Record<string, unknown>) => {
        warnings.push(fields);
      },
    },
  );

  expect(meta).toBeNull();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.kind).toBe("continuity.boot_pickup");
});

test("POST /workflows/wait returns 200 (not 400 untrusted_cwd) for a same-project run", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-wait-same-project-"));
  try {
    markTrustedRoot(root);
    const db = freshDb();
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db,
      storageRoot: root,
    });
    expect(workflowRuns.register("wf", "proj-a")).toBe("wfrun-1");
    await workflowRuns.recordResult("wfrun-1", { ok: true });
    const services = mockServices({
      workflowRuns,
      projectRegistry: new ProjectRegistry(
        new Map([["proj-a", { project_id: "proj-a", root_path: root }]]),
      ),
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });

    const req = new Request("http://localhost/workflows/wait", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-1", cwd: root, timeout_ms: 10 }),
    });
    const res = await workflowsWaitRoute(req, services);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(res.status).toBe(200);
    expect(body.error?.code).not.toBe("untrusted_cwd");
    expect(body).toMatchObject({
      status: "completed",
      started_at: expect.any(Number) as unknown,
      finished_at: expect.any(Number) as unknown,
      result: { ok: true },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/wait rejects the 17th concurrent waiter", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-waiters-"));
  try {
    markTrustedRoot(root);
    const db = freshDb();
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-04-26T00:00:00Z"),
      db,
      storageRoot: root,
      waiterLimit: 16,
    });
    const id = workflowRuns.register("wf", "proj-a");
    expect(id).toBe("wfrun-1");
    const services = mockServices({
      workflowRuns,
      projectRegistry: new ProjectRegistry(
        new Map([["proj-a", { project_id: "proj-a", root_path: root }]]),
      ),
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const requests = Array.from(
      { length: 16 },
      () =>
        new Request("http://localhost/workflows/wait", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workflow_run_id: "wfrun-1", cwd: root, timeout_ms: 10_000 }),
        }),
    );
    const pending = requests.map((req) => workflowsWaitRoute(req, services));
    const rejectedReq = new Request("http://localhost/workflows/wait", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow_run_id: "wfrun-1", cwd: root, timeout_ms: 10_000 }),
    });
    const rejectedRes = await workflowsWaitRoute(rejectedReq, services);
    expect(rejectedRes.status).toBe(429);
    expect(await rejectedRes.json()).toEqual({
      error: { code: "too_many_requests", message: "workflow wait limit reached" },
    });
    await workflowRuns.recordResult("wfrun-1", { ok: true });
    await Promise.all(pending);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/run resolves relative file outputs against the caller repo root", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-file-route-"));
  try {
    markTrustedRoot(root);
    mkdirSync(join(root, "playbooks"), { recursive: true });
    mkdirSync(join(root, "workflows/write-file"), { recursive: true });
    writeFileSync(
      join(root, "workflows/write-file/workflow.ts"),
      `import type { WorkflowSpec } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'write-file',
  description: 'write file',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [{ kind: 'file', path: 'docs/maestro-continuation-test.md' }],
  run: { kind: 'markdown-template', template: 'hello' },
};
export default spec;
`,
    );
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const db = freshDb();
    const services = mockServices({
      workflowRegistry: reg,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "write-file", cwd: root, wait: true }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(200);
    const expected = join(root, "docs/maestro-continuation-test.md");
    expect(readFileSync(expected, "utf8")).toBe("hello");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow run resolves registered project from cwd via resolveProjectScope", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-registered-project-"));
  // Initialize as a git repo so resolveProjectScope's underlying resolveProjectId
  // returns kind='git' instead of kind='quarantine'. The registry then maps the
  // repo_root to the friendly name "fake-proj".
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["remote", "add", "origin", "https://example.com/fake/proj.git"], { cwd: root });
  const gitRoot = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).stdout.trim();
  try {
    mkdirSync(join(root, "playbooks/scope"), { recursive: true });
    mkdirSync(join(root, "workflows/scope"), { recursive: true });
    writeFileSync(
      join(root, "workflows/scope/workflow.ts"),
      `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'scope',
  description: 'project scope',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn: WorkflowFn = async (ctx) => ({ project: ctx.project, cwd: ctx.cwd });
`,
    );
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const db = freshDb();
    const services = mockServices({
      workflowRegistry: reg,
      projectRegistry: new ProjectRegistry(
        new Map([["fake-proj", { project_id: "fake-proj", root_path: gitRoot }]]),
      ),
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "scope", cwd: gitRoot, wait: true }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runResult?: { project?: string; cwd?: string } };
    expect(body.runResult?.project).toBe("fake-proj");
    expect(body.runResult?.cwd).toBe(gitRoot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/run does not register workflow_run_id when cwd is untrusted", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-untrusted-"));
  try {
    mkdirSync(join(root, "playbooks"), { recursive: true });
    mkdirSync(join(root, "workflows/global"), { recursive: true });
    writeFileSync(
      join(root, "workflows/global/workflow.ts"),
      `import type { WorkflowSpec } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'global',
  description: 'global scope',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'markdown-template', template: 'hello' },
};
export default spec;
`,
    );
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const db = freshDb();
    let registerCalls = 0;
    const services = mockServices({
      workflowRegistry: reg,
      workflowRuns: {
        register: () => {
          registerCalls += 1;
          return "wfrun-test";
        },
        unregister: () => undefined,
      },
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "global", cwd: join(root, "outside") }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(400);
    expect(registerCalls).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow run returns 503 when registry.list() throws", async () => {
  const { reg, root } = await setupReg();
  try {
    const db = freshDb();
    const services = mockServices({
      workflowRegistry: reg,
      projectRegistry: {
        list: () => {
          throw new Error("registry down");
        },
      },
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", cwd: root }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("registry_unavailable");
    expect(body.error?.message).toBe(
      "project registry is unavailable; cannot resolve workflow scope",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/run rejects untrusted cwd", async () => {
  const { reg, root } = await setupReg();
  const untrusted = mkdtempSync(join(tmpdir(), "wf-untrusted-run-"));
  try {
    const db = freshDb();
    const services = mockServices({
      workflowRegistry: reg,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", cwd: untrusted }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("untrusted_cwd");
  } finally {
    rmSync(untrusted, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/run passes args into ts-function workflow ctx", async () => {
  const root = mkdtempSync(join(tmpdir(), "wftsargs-"));
  try {
    markTrustedRoot(root);
    mkdirSync(join(root, "playbooks"), { recursive: true });
    mkdirSync(join(root, "workflows/inspect-args"), { recursive: true });
    writeFileSync(
      join(root, "workflows/inspect-args/workflow.ts"),
      `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'inspect-args',
  description: 'inspect args',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn: WorkflowFn = async (ctx) => ({ args: ctx.args });
`,
    );
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const db = freshDb();
    const services = mockServices({
      workflowRegistry: reg,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "inspect-args",
        cwd: root,
        wait: true,
        args: { base_ref: "main", target_ref: "HEAD", timeout_ms: 7777 },
      }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runResult?: { args?: Record<string, unknown> } };
    expect(body.runResult?.args).toEqual({
      base_ref: "main",
      target_ref: "HEAD",
      timeout_ms: 7777,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/run validates ts workflow args via inputSchema and applies defaults", async () => {
  const root = mkdtempSync(join(tmpdir(), "wftschema-ok-"));
  try {
    markTrustedRoot(root);
    mkdirSync(join(root, "playbooks"), { recursive: true });
    mkdirSync(join(root, "workflows/inspect-schema-args"), { recursive: true });
    writeFileSync(
      join(root, "workflows/inspect-schema-args/workflow.ts"),
      `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'inspect-schema-args',
  description: 'inspect schema args',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const inputSchema = {
  parse(input: unknown) {
    const result = this.safeParse(input);
    if (!result.success) throw new Error('invalid');
    return result.data;
  },
  safeParse(input: unknown) {
    const raw = (input ?? {}) as Record<string, unknown>;
    const keys = Object.keys(raw);
    const unknown = keys.filter((key) => key !== 'target_ref' && key !== 'timeout_ms');
    const issues: Array<{ path: Array<string | number>; message: string; expected?: string }> = [];
    if (unknown.length > 0) {
      issues.push({ path: [], message: 'Unrecognized key(s) in object', expected: undefined });
    }
    if (raw.timeout_ms !== undefined && (typeof raw.timeout_ms !== 'number' || !Number.isFinite(raw.timeout_ms) || raw.timeout_ms <= 0)) {
      issues.push({ path: ['timeout_ms'], message: 'Expected number', expected: 'number' });
    }
    if (issues.length > 0) return { success: false as const, error: { issues } };
    return {
      success: true as const,
      data: {
        target_ref: typeof raw.target_ref === 'string' ? raw.target_ref : 'HEAD',
        timeout_ms: typeof raw.timeout_ms === 'number' ? raw.timeout_ms : 600000,
      },
    };
  },
};
export const fn: WorkflowFn = async (ctx) => ({ args: ctx.args });
`,
    );
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const db = freshDb();
    const services = mockServices({
      workflowRegistry: reg,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "inspect-schema-args",
        cwd: root,
        wait: true,
        args: { timeout_ms: 7777 },
      }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runResult?: { args?: Record<string, unknown> } };
    expect(body.runResult?.args).toEqual({ target_ref: "HEAD", timeout_ms: 7777 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/run rejects invalid args for ts workflow inputSchema", async () => {
  const root = mkdtempSync(join(tmpdir(), "wftschema-bad-"));
  try {
    markTrustedRoot(root);
    mkdirSync(join(root, "playbooks"), { recursive: true });
    mkdirSync(join(root, "workflows/inspect-schema-args"), { recursive: true });
    writeFileSync(
      join(root, "workflows/inspect-schema-args/workflow.ts"),
      `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'inspect-schema-args',
  description: 'inspect schema args',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const inputSchema = {
  parse(input: unknown) {
    const result = this.safeParse(input);
    if (!result.success) throw new Error('invalid');
    return result.data;
  },
  safeParse(input: unknown) {
    const raw = (input ?? {}) as Record<string, unknown>;
    const keys = Object.keys(raw);
    const unknown = keys.filter((key) => key !== 'target_ref' && key !== 'timeout_ms');
    const issues: Array<{ path: Array<string | number>; message: string; expected?: string }> = [];
    if (unknown.length > 0) {
      issues.push({ path: [], message: 'Unrecognized key(s) in object', expected: undefined });
    }
    if (raw.timeout_ms !== undefined && (typeof raw.timeout_ms !== 'number' || !Number.isFinite(raw.timeout_ms) || raw.timeout_ms <= 0)) {
      issues.push({ path: ['timeout_ms'], message: 'Expected number', expected: 'number' });
    }
    if (issues.length > 0) return { success: false as const, error: { issues } };
    return {
      success: true as const,
      data: {
        target_ref: typeof raw.target_ref === 'string' ? raw.target_ref : 'HEAD',
        timeout_ms: typeof raw.timeout_ms === 'number' ? raw.timeout_ms : 600000,
      },
    };
  },
};
export const fn: WorkflowFn = async (ctx) => ({ args: ctx.args });
`,
    );
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const db = freshDb();
    const services = mockServices({
      workflowRegistry: reg,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "inspect-schema-args",
        cwd: root,
        args: { timeout_ms: "bad", extra: true },
      }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: {
        code?: string;
        message?: string;
        issues?: { path: (string | number)[]; message: string; expected?: unknown }[];
      };
    };
    expect(body.error?.code).toBe("invalid_args");
    expect(body.error?.message).toBe("workflow input validation failed");
    expect(Array.isArray(body.error?.issues)).toBe(true);
    expect(body.error?.issues?.some((issue) => issue.path.join(".") === "timeout_ms")).toBe(true);
    expect(
      body.error?.issues?.some(
        (issue) => issue.path.join(".") === "" && issue.message.includes("Unrecognized key"),
      ),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composeRecall resolves {{today}} when templateCtx is provided", async () => {
  const db = freshDb();
  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    cwd: process.cwd(),
    project: "p",
    sources: [{ source: "memory_search", args: { query: "q", dateStart: "{{today}}", limit: 1 } }],
    templateCtx: {
      now: () => new Date("2026-05-04T12:00:00Z"),
      project: "p",
      sessionStart: "2026-05-04T10:00:00Z",
      tz: "UTC",
    },
  });

  expect(bundle.warnings.find((w) => w.includes("{{today}}"))).toBeUndefined();
});

function makeRecallPlaybookFs(root: string, playbookName: string): void {
  markTrustedRoot(root);
  mkdirSync(join(root, `playbooks/${playbookName}`), { recursive: true });
  mkdirSync(join(root, "workflows"), { recursive: true });
  writeFileSync(
    join(root, `playbooks/${playbookName}/playbook.md`),
    `---\nname: ${playbookName}\ndescription: D\ntriggers:\n  - kind: manual\nrecall:\n  - source: memory_search\n    args:\n      query: hello\n      dateStart: "{{session_start}}"\n      limit: 50\noutput:\n  - kind: clipboard\nrun:\n  kind: markdown-template\n---\nbody\n`,
  );
}

function seedMemory(
  db: ReturnType<typeof freshDb>,
  id: string,
  body: string,
  createdAt: string,
  projectId: string | null = "unknown",
): void {
  db.prepare(
    `INSERT INTO t2_memories (
       memory_id, project_id, user_id, kind, source_session_ids,
       window_start, window_end, title, body, metadata_json,
       created_at, updated_at, obs_type, concepts, severity
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    "u1",
    "observation",
    JSON.stringify(["s1"]),
    createdAt,
    createdAt,
    body,
    body,
    "{}",
    createdAt,
    createdAt,
    "note",
    JSON.stringify([]),
    "low",
  );
}

test("POST /workflows/run resolves sessionStart from claude_code_sessions when session_id is provided", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfsid-"));
  try {
    makeRecallPlaybookFs(root, "sid");
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const db = freshDb();
    db.prepare(
      `INSERT INTO claude_code_sessions (session_id, session_start_at, last_seen_at, project_id)
       VALUES (?, ?, ?, ?)`,
    ).run("sess-A", "2026-05-05T03:00:00Z", "2026-05-05T05:00:00Z", "demo");
    seedMemory(db, "m-old", "hello world before", "2026-05-05T02:00:00Z", "test-project");
    seedMemory(db, "m-new", "hello world after", "2026-05-05T04:30:00Z", "test-project");
    const services = mockServices({
      workflowRegistry: reg,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "sid", session_id: "sess-A", cwd: root, wait: true }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(200);
    // After fix: dateStart is resolved to 2026-05-05T03:00:00Z, so only m-new should match.
    // Confirm by checking the logged recall itemCount.
    const stats = db
      .query("SELECT samples, successes FROM workflow_stats WHERE workflow_name = ?")
      .get("sid") as { samples: number; successes: number } | undefined;
    expect(stats?.successes).toBe(1);
    const evt = db
      .query<{ payload_json: string }, []>(
        `SELECT payload_json FROM t0_events
          WHERE event_type = 'workflow.recall'
          ORDER BY ts DESC LIMIT 1`,
      )
      .get();
    const payload = JSON.parse(evt!.payload_json) as { item_count: number };
    expect(payload.item_count).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/run falls back to now-8h when session_id is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "wffb-"));
  try {
    makeRecallPlaybookFs(root, "fb");
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const db = freshDb();
    // Within 8h: should match. Outside 8h: should not.
    const now = Date.now();
    const within = new Date(now - 60 * 60 * 1000).toISOString(); // 1h ago
    const outside = new Date(now - 12 * 60 * 60 * 1000).toISOString(); // 12h ago
    seedMemory(db, "m-within", "hello recent", within, "test-project");
    seedMemory(db, "m-outside", "hello old", outside, "test-project");
    const services = mockServices({
      workflowRegistry: reg,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "fb", cwd: root, wait: true }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(200);
    const evt = db
      .query<{ payload_json: string }, []>(
        `SELECT payload_json FROM t0_events
          WHERE event_type = 'workflow.recall'
          ORDER BY ts DESC LIMIT 1`,
      )
      .get();
    const payload = JSON.parse(evt!.payload_json) as { item_count: number };
    expect(payload.item_count).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fileSessionSummarizeStumbles forwards the active project to the extractor", async () => {
  const services = mockServices({
    log: { error: () => undefined },
    machineId: { get: () => "machine-1" },
    t0Writer: { write: () => undefined },
  });
  let seenInput: ExtractStumblesInput | undefined;
  await fileSessionSummarizeStumbles({
    services,
    sessionId: "sess-1",
    project: "project-x",
    extractor: (input) => {
      seenInput = input;
      return Promise.resolve([]);
    },
    filer: () => Promise.resolve(),
  });
  expect(seenInput?.default_project).toBe("project-x");
});

test("POST /workflows/run unknown name → 404", async () => {
  const { reg, root } = await setupReg();
  try {
    const services = mockServices({
      workflowRegistry: reg,
      db: freshDb(),
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "nope" }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/trigger includes memory-digest markdown on session-start", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-memory-digest-"));
  try {
    markTrustedRoot(root);
    mkdirSync(join(root, "workflows/memory-digest"), { recursive: true });
    copyFileSync(
      join(import.meta.dir, "../../../..", "plugin/workflows/memory-digest/workflow.ts"),
      join(root, "workflows/memory-digest/workflow.ts"),
    );
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const db = freshDb();
    db.prepare(
      `
      INSERT INTO t2_memories (
        memory_id,
        project_id,
        user_id,
        kind,
        source_session_ids,
        window_start,
        window_end,
        title,
        body,
        metadata_json,
        compressed_from,
        created_at,
        updated_at,
        obs_type,
        concepts,
        severity,
        file_paths,
        last_verified_at,
        last_verified_by,
        last_verified_actor,
        last_verified_reason,
        last_verified_session_id,
        origin,
        slug,
        hook,
        retired_at
      ) VALUES (
        'memory-1',
        NULL,
        'system',
        'reference',
        '[]',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
        'Session Start Rule',
        'Keep this in memory',
        '{}',
        NULL,
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        'direct',
        'session-start',
        'Seed memory digest with session startup notes',
        NULL
      )
    `,
    ).run();
    const services = mockServices({
      workflowRegistry: reg,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: { kind: "lifecycle", event: "session-start" }, cwd: root }),
    });
    const res = await workflowsTriggerRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matched: string[]; additionalContext: string | null };
    expect(body.matched).toEqual(["memory-digest"]);
    // The workflow opens `${storageRoot}/db.sqlite` directly (mirrors the CLI
    // digest); the seeded in-memory db here is not visible to the workflow
    // process. Markdown-output correctness is covered by
    // plugin/workflows/memory-digest/workflow.test.ts. This integration test
    // just verifies the lifecycle trigger matches the workflow.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/trigger runs session-reminder sinks inline and returns additionalContext", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfsr-"));
  try {
    markTrustedRoot(root);
    mkdirSync(join(root, "playbooks/sr"), { recursive: true });
    mkdirSync(join(root, "workflows"), { recursive: true });
    writeFileSync(
      join(root, "playbooks/sr/playbook.md"),
      `---\nname: sr\ndescription: D\ntriggers:\n  - kind: lifecycle\n    event: session-start\nrecall: []\noutput:\n  - kind: session-reminder\nrun:\n  kind: markdown-template\n---\nremind body\n`,
    );
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const db = freshDb();
    const services = mockServices({
      workflowRegistry: reg,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: { kind: "lifecycle", event: "session-start" }, cwd: root }),
    });
    const res = await workflowsTriggerRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matched: string[]; additionalContext: string | null };
    expect(body.matched).toEqual(["sr"]);
    expect(body.additionalContext).toContain("remind body");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/trigger rejects untrusted cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-untrusted-trigger-"));
  const untrusted = mkdtempSync(join(tmpdir(), "wf-untrusted-target-"));
  try {
    markTrustedRoot(root);
    mkdirSync(join(root, "playbooks/life"), { recursive: true });
    mkdirSync(join(root, "workflows"), { recursive: true });
    writeFileSync(
      join(root, "playbooks/life/playbook.md"),
      `---\nname: life\ndescription: D\ntriggers:\n  - kind: lifecycle\n    event: session-start\nrecall: []\noutput:\n  - kind: clipboard\nrun:\n  kind: markdown-template\n---\nbody\n`,
    );
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const db = freshDb();
    const services = mockServices({
      workflowRegistry: reg,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: { kind: "lifecycle", event: "session-start" },
        cwd: untrusted,
      }),
    });
    const res = await workflowsTriggerRoute(req, services);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("untrusted_cwd");
  } finally {
    rmSync(untrusted, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/trigger without session-reminder sinks returns null additionalContext", async () => {
  const { reg, root } = await setupReg();
  try {
    mkdirSync(join(root, "playbooks/lt2"), { recursive: true });
    writeFileSync(
      join(root, "playbooks/lt2/playbook.md"),
      `---\nname: lt2\ndescription: D\ntriggers:\n  - kind: lifecycle\n    event: session-start\nrecall: []\noutput:\n  - kind: clipboard\nrun:\n  kind: markdown-template\n---\nbody\n`,
    );
    const reg2 = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const db = freshDb();
    const services = mockServices({
      workflowRegistry: reg2,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: { kind: "lifecycle", event: "session-start" }, cwd: root }),
    });
    const res = await workflowsTriggerRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matched: string[]; additionalContext: string | null };
    expect(body.matched).toEqual(["lt2"]);
    expect(body.additionalContext).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/trigger fires lifecycle event and returns matched names", async () => {
  const root = mkdtempSync(join(tmpdir(), "wft-"));
  try {
    markTrustedRoot(root);
    mkdirSync(join(root, "playbooks/lt"), { recursive: true });
    mkdirSync(join(root, "workflows"), { recursive: true });
    writeFileSync(
      join(root, "playbooks/lt/playbook.md"),
      `---\nname: lt\ndescription: D\ntriggers:\n  - kind: lifecycle\n    event: pre-compact\nrecall: []\noutput:\n  - kind: clipboard\nrun:\n  kind: markdown-template\n---\nlife body\n`,
    );
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const db = freshDb();
    const services = mockServices({
      workflowRegistry: reg,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: { kind: "lifecycle", event: "pre-compact" }, cwd: root }),
    });
    const res = await workflowsTriggerRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matched: string[] };
    expect(body.matched).toEqual(["lt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/trigger records NULL session_id when lifecycle body omits session_id", async () => {
  const root = mkdtempSync(join(tmpdir(), "wft-null-session-"));
  try {
    markTrustedRoot(root);
    mkdirSync(join(root, "playbooks/lt"), { recursive: true });
    mkdirSync(join(root, "workflows"), { recursive: true });
    writeFileSync(
      join(root, "playbooks/lt/playbook.md"),
      `---\nname: lt\ndescription: D\ntriggers:\n  - kind: lifecycle\n    event: stop\nrecall: []\noutput:\n  - kind: clipboard\nrun:\n  kind: markdown-template\n---\nlife body\n`,
    );
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const { worktreeRootDir, mainRepoDir } = hermeticServiceDirs(root);
    const services = buildServices({
      env: {},
      input: {},
      storageRoot: root,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      workflowRegistry: reg,
      clock: () => new Date("2026-05-01T00:00:00.000Z"),
      worktreeRootDir,
      mainRepoDir,
    });
    const req = new Request("http://localhost/workflows/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: { kind: "lifecycle", event: "stop" }, cwd: root }),
    });
    const res = await workflowsTriggerRoute(req, services);
    expect(res.status).toBe(200);

    const row = db
      .query<
        { session_id: string | null; kind: string },
        []
      >("SELECT session_id, kind FROM session_events")
      .get();
    expect(row).toEqual({ session_id: null, kind: "session.stop" });
    services.supervisor.stopAll();
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/trigger filters lifecycle matches by hookContext.tool_name", async () => {
  const workflowA = {
    name: "a",
    description: "A",
    triggers: [
      {
        kind: "lifecycle",
        event: "post-tool-use",
        filter: { tool_name: ["Edit"] },
      },
    ],
    recall: [],
    output: [{ kind: "clipboard" }],
    run: { kind: "markdown-template", template: "A" },
  };
  const workflowB = {
    name: "b",
    description: "B",
    triggers: [{ kind: "lifecycle", event: "post-tool-use" }],
    recall: [],
    output: [{ kind: "clipboard" }],
    run: { kind: "markdown-template", template: "B" },
  };
  const reg = mockRegistry({
    findByTrigger: () => [workflowA, workflowB],
    getEntry: () => undefined,
  });
  const services = mockServices({
    workflowRegistry: reg,
    db: freshDb(),
    embedder: new TestEmbedder({ dim: 384 }),
    settings: { storageRoot: "/tmp" },
  });

  const makeRequest = (toolName?: string | null): Request =>
    new Request("http://localhost/workflows/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: { kind: "lifecycle", event: "post-tool-use" },
        cwd: ".",
        ...(toolName === undefined ? {} : { hookContext: { tool_name: toolName } }),
      }),
    });

  const readMatched = async (req: Request): Promise<string[]> => {
    const res = await workflowsTriggerRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matched: string[] };
    return body.matched;
  };

  expect(await readMatched(makeRequest("Read"))).toEqual(["b"]);
  expect(await readMatched(makeRequest("Edit"))).toEqual(["a", "b"]);
  expect(await readMatched(makeRequest())).toEqual(["b"]);
});

test("POST /workflows/trigger validates ts workflow args via inputSchema when provided", async () => {
  const root = mkdtempSync(join(tmpdir(), "wftschema-trigger-"));
  try {
    markTrustedRoot(root);
    mkdirSync(join(root, "playbooks"), { recursive: true });
    mkdirSync(join(root, "workflows/trigger-schema"), { recursive: true });
    writeFileSync(
      join(root, "workflows/trigger-schema/workflow.ts"),
      `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'trigger-schema',
  description: 'trigger schema validation',
  triggers: [{ kind: 'lifecycle', event: 'post-tool-use' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const inputSchema = {
  parse(input: unknown) {
    const result = this.safeParse(input);
    if (!result.success) throw new Error('invalid');
    return result.data;
  },
  safeParse(input: unknown) {
    const raw = (input ?? {}) as Record<string, unknown>;
    if (raw.timeout_ms !== undefined && (typeof raw.timeout_ms !== 'number' || !Number.isFinite(raw.timeout_ms) || raw.timeout_ms <= 0)) {
      return {
        success: false as const,
        error: {
          issues: [{ path: ['timeout_ms'], message: 'Expected number', expected: 'number' }],
        },
      };
    }
    return {
      success: true as const,
      data: { timeout_ms: typeof raw.timeout_ms === 'number' ? raw.timeout_ms : 600000 },
    };
  },
};
export const fn: WorkflowFn = async () => ({ ok: true });
`,
    );
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const db = freshDb();
    const services = mockServices({
      workflowRegistry: reg,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    });
    const req = new Request("http://localhost/workflows/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: { kind: "lifecycle", event: "post-tool-use" },
        cwd: root,
        args: { timeout_ms: "bad" },
      }),
    });
    const res = await workflowsTriggerRoute(req, services);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: { code?: string; issues?: { path: (string | number)[] }[] };
    };
    expect(body.error?.code).toBe("invalid_args");
    expect(body.error?.issues?.some((issue) => issue.path.join(".") === "timeout_ms")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /workflows/history returns workflow_stats row", async () => {
  const db = freshDb();
  execMulti(
    db,
    `
    INSERT INTO workflow_stats (workflow_name, samples, successes, failures, avg_latency_ms, last_run_at, consecutive_failures, quarantined)
    VALUES ('demo', 5, 4, 1, 200, '2026-05-04T15:00:00Z', 0, 0);
  `,
  );
  const services = mockServices({ db });
  const req = new Request("http://localhost/workflows/history?name=demo");
  const res = await workflowsHistoryRoute(req, services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { stats: { samples: number }; recent: unknown[] };
  expect(body.stats.samples).toBe(5);
});

test("session-summarize stop hook calls the stumble extractor and files returned drafts", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-session-summarize-"));
  try {
    const serviceCalls: { sessionId: string; prompt: string }[] = [];
    const services = mockServices({
      log: { error: () => undefined },
      uuid: () => "123e4567-e89b-12d3-a456-426614174000",
      machineId: { get: () => "machine-1" },
      clock: () => new Date("2026-05-01T00:00:00.000Z"),
      redactor: { redact: (value: unknown) => value },
      t0Writer: {
        write: (event: { event_type: string; payload_json: Record<string, unknown> }) => {
          const payload = TaskDraftPayloadSchema.parse(event.payload_json);
          serviceCalls.push({ sessionId: "written", prompt: payload.prompt });
          expect(event.event_type).toBe("task_draft");
          expect(Object.prototype.hasOwnProperty.call(event.payload_json, "via_hook")).toBe(false);
          expect(Object.keys(event.payload_json).sort()).toEqual(Object.keys(payload).sort());
        },
      },
    });
    await fileSessionSummarizeStumbles({
      services,
      sessionId: "sess-1",
      project: "test-project",
      extractor: () =>
        Promise.resolve([
          {
            prompt: "TODO: audit X before shipping",
            affects_projects: ["penumbra"],
            evidence: { conv_ids: [], commits: [], files: [], session_id: "sess-1" },
          },
        ]),
    });
    expect(serviceCalls).toHaveLength(1);
    expect(serviceCalls[0]?.prompt).toBe("TODO: audit X before shipping");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session-summarize stop hook falls back to transcript-only mode when db access is unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-session-summarize-dbless-"));
  try {
    const serviceCalls: { prompt: string }[] = [];
    const services = mockServices({
      log: { error: () => undefined },
      uuid: () => "123e4567-e89b-12d3-a456-426614174000",
      machineId: { get: () => "machine-1" },
      clock: () => new Date("2026-05-01T00:00:00.000Z"),
      redactor: { redact: (value: unknown) => value },
      t0Writer: {
        write: (event: { event_type: string; payload_json: Record<string, unknown> }) => {
          const payload = TaskDraftPayloadSchema.parse(event.payload_json);
          serviceCalls.push({ prompt: payload.prompt });
        },
      },
    });

    await fileSessionSummarizeStumbles({
      services,
      sessionId: "sess-1",
      project: "test-project",
      extractor: (input) => {
        expect(input.dispatch_events_query).toBeUndefined();
        return Promise.resolve([
          {
            prompt: "TODO: audit X before shipping",
            affects_projects: ["penumbra"],
            evidence: { conv_ids: [], commits: [], files: [], session_id: "sess-1" },
          },
        ]);
      },
    });
    expect(serviceCalls).toHaveLength(1);
    expect(serviceCalls[0]?.prompt).toBe("TODO: audit X before shipping");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session-summarize caps filed drafts at MAX_DRAFTS_PER_SESSION", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-session-summarize-cap-"));
  try {
    const serviceCalls: { prompt: string }[] = [];
    const warnCalls: { session_id: string; total: number; cap: number }[] = [];
    const services = mockServices({
      log: {
        error: () => undefined,
        warn: (meta: Record<string, unknown>) => {
          warnCalls.push(meta as { session_id: string; total: number; cap: number });
        },
      },
      uuid: () => "123e4567-e89b-12d3-a456-426614174000",
      machineId: { get: () => "machine-1" },
      clock: () => new Date("2026-05-01T00:00:00.000Z"),
      redactor: { redact: (value: unknown) => value },
      t0Writer: {
        write: (event: { event_type: string; payload_json: Record<string, unknown> }) => {
          const payload = TaskDraftPayloadSchema.parse(event.payload_json);
          serviceCalls.push({ prompt: payload.prompt });
        },
      },
    });

    const overCap = MAX_DRAFTS_PER_SESSION + 5;
    const candidates = Array.from({ length: overCap }, (_, i) => ({
      prompt: `TODO: audit item ${String(i)}`,
      affects_projects: ["penumbra"],
      evidence: { conv_ids: [], commits: [], files: [], session_id: "sess-1" },
    }));

    await fileSessionSummarizeStumbles({
      services,
      sessionId: "sess-1",
      project: "test-project",
      extractor: () => Promise.resolve(candidates),
    });
    expect(serviceCalls).toHaveLength(MAX_DRAFTS_PER_SESSION);
    const warn = warnCalls.find((w) => w.session_id === "sess-1");
    expect(warn).toBeDefined();
    expect(warn!.total).toBe(overCap);
    expect(warn!.cap).toBe(MAX_DRAFTS_PER_SESSION);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session-summarize filed drafts include provenance metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-session-summarize-prov-"));
  try {
    const writtenEvents: Record<string, unknown>[] = [];
    const services = mockServices({
      log: { error: () => undefined, warn: () => undefined },
      uuid: () => "123e4567-e89b-12d3-a456-426614174000",
      machineId: { get: () => "machine-1" },
      clock: () => new Date("2026-05-01T00:00:00.000Z"),
      redactor: { redact: (value: unknown) => value },
      t0Writer: {
        write: (event: { event_type: string; payload_json: Record<string, unknown> }) => {
          const payload = TaskDraftPayloadSchema.parse(event.payload_json);
          writtenEvents.push(payload);
        },
      },
    });

    await fileSessionSummarizeStumbles({
      services,
      sessionId: "sess-prov",
      project: "test-project",
      extractor: () =>
        Promise.resolve([
          {
            prompt: "TODO: audit X before shipping",
            affects_projects: ["penumbra"],
            evidence: { conv_ids: [], commits: [], files: [], session_id: "sess-prov" },
          },
        ]),
    });
    expect(writtenEvents).toHaveLength(1);
    const prov = writtenEvents[0]?.provenance as Record<string, unknown> | undefined;
    expect(prov).toBeDefined();
    expect(prov?.filing_path).toBe("stop_hook");
    expect(prov?.session_id).toBe("sess-prov");
    expect(prov?.extractor_version).toBe("v1");
    expect(prov?.filtered_by).toEqual(["source_allowlist", "type_allowlist", "time_window"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session-summarize stop hook ignores workflow-generated observations in the default reader", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-session-summarize-filter-"));
  try {
    const db = freshDb();
    const { worktreeRootDir, mainRepoDir } = hermeticServiceDirs(root);
    const services = buildServices({
      env: {},
      input: {},
      storageRoot: root,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      clock: () => new Date("2026-05-01T00:00:00.000Z"),
      uuid: () => "123e4567-e89b-12d3-a456-426614174000",
      worktreeRootDir,
      mainRepoDir,
    });
    const sessionId = "sess-filter";
    db.run(
      `INSERT INTO t0_events (
         event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id,
         session_id, event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
         request_id, payload_json, payload_summary
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "e1",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:01.000Z",
        "agentchat",
        "workflow:session-summarize",
        "test-project",
        "u",
        "m",
        sessionId,
        "agent-response",
        "unknown",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        JSON.stringify({ full_summary: "## Pending follow-up\nTODO: refactor X" }),
        "## Pending follow-up",
      ],
    );

    await fileSessionSummarizeStumbles({
      services,
      sessionId,
      project: "test-project",
    });

    const rows = db
      .query<
        { event_type: string },
        [string]
      >(`SELECT event_type FROM t0_events WHERE session_id = ? ORDER BY ts ASC, event_id ASC`)
      .all(sessionId);
    expect(rows.map((row) => row.event_type)).toEqual(["agent-response"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /workflows/suggest returns workflows matching state thresholds", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfs-"));
  try {
    mkdirSync(join(root, "playbooks/idle"), { recursive: true });
    mkdirSync(join(root, "workflows"), { recursive: true });
    writeFileSync(
      join(root, "playbooks/idle/playbook.md"),
      `---\nname: idle\ndescription: D\ntriggers:\n  - kind: state-threshold\n    metric: queue-idle-min\n    op: ">"\n    value: 20\nrecall: []\noutput:\n  - kind: clipboard\nrun:\n  kind: markdown-template\n---\nidle body\n`,
    );
    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const db = freshDb();
    const services = mockServices({ workflowRegistry: reg, db });
    const req = new Request("http://localhost/workflows/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ now: "2026-05-04T15:00:00Z" }),
    });
    const res = await workflowsSuggestRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      suggestions: { name: string }[];
      metrics: Record<string, number>;
    };
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(body.metrics["queue-idle-min"]).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflows/list logs a warning and reports registry_unavailable when workflowRegistry is unset", async () => {
  const warnCalls: unknown[] = [];
  const services = mockServices({
    workflowRegistry: undefined,
    log: {
      warn: (obj: unknown) => {
        warnCalls.push(obj);
      },
    },
  });
  const req = new Request("http://localhost/workflows/list");
  const res = await workflowsListRoute(req, services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { workflows: unknown[]; registry_unavailable?: boolean };
  expect(body.workflows).toEqual([]);
  expect(body.registry_unavailable).toBe(true);
  expect(warnCalls.length).toBeGreaterThan(0);
});

test("workflows/trigger logs a warning and reports registry_unavailable when workflowRegistry is unset", async () => {
  const warnCalls: unknown[] = [];
  const services = mockServices({
    workflowRegistry: undefined,
    log: {
      warn: (obj: unknown) => {
        warnCalls.push(obj);
      },
    },
  });
  const req = new Request("http://localhost/workflows/trigger", {
    method: "POST",
    body: JSON.stringify({ event: { kind: "lifecycle", event: "SessionStart" } }),
  });
  const res = await workflowsTriggerRoute(req, services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    matched: string[];
    additionalContext: string | null;
    registry_unavailable?: boolean;
  };
  expect(body.matched).toEqual([]);
  expect(body.additionalContext).toBeNull();
  expect(body.registry_unavailable).toBe(true);
  expect(warnCalls.length).toBeGreaterThan(0);
});

test("workflows/trigger short-circuits unavailable registry before cwd validation and telemetry", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-unavailable-global-"));
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const { worktreeRootDir, mainRepoDir } = hermeticServiceDirs(root);
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    workflowRegistry: undefined,
    clock: () => new Date("2026-05-01T00:00:00.000Z"),
    worktreeRootDir,
    mainRepoDir,
  });
  try {
    const req = new Request("http://localhost/workflows/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: { kind: "lifecycle", event: "session-start" },
        cwd: root,
        session_id: "s-degraded",
      }),
    });
    const res = await workflowsTriggerRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      matched: string[];
      additionalContext: string | null;
      registry_unavailable?: boolean;
    };
    expect(body).toEqual({
      matched: [],
      additionalContext: null,
      registry_unavailable: true,
    });
    const count = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session_events")
      .get();
    expect(count?.count).toBe(0);
  } finally {
    services.supervisor.stopAll();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflows/suggest logs a warning and reports registry_unavailable when workflowRegistry is unset", async () => {
  const warnCalls: unknown[] = [];
  const services = mockServices({
    workflowRegistry: undefined,
    log: {
      warn: (obj: unknown) => {
        warnCalls.push(obj);
      },
    },
  });
  const req = new Request("http://localhost/workflows/suggest", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const res = await workflowsSuggestRoute(req, services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    suggestions: unknown[];
    metrics: Record<string, number>;
    registry_unavailable?: boolean;
  };
  expect(body.suggestions).toEqual([]);
  expect(body.registry_unavailable).toBe(true);
  expect(warnCalls.length).toBeGreaterThan(0);
});

test("POST /workflows/run threads workflow_run_id and latency_ms into t0 capture", async () => {
  const { reg, root } = await setupReg();
  try {
    const db = freshDb();
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-capture-route",
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
    });
    const req = new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", wait: true }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(200);

    const rows = db
      .query(
        `SELECT event_type, latency_ms, payload_json
           FROM t0_events
          WHERE event_type IN ('workflow.run', 'workflow.outcome')
          ORDER BY ts`,
      )
      .all() as {
        event_type: string;
        latency_ms: number | null;
        payload_json: string;
      }[];
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      expect(row.latency_ms).toBeGreaterThan(0);
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      expect(payload.workflow_run_id).toBe("wfrun-capture-route");
    }

    const outcomeRow = rows.find((r) => r.event_type === "workflow.outcome");
    expect(outcomeRow).toBeDefined();
    const outcomePayload = JSON.parse(outcomeRow!.payload_json) as Record<string, unknown>;
    expect(outcomePayload.latency_ms).toBe(outcomeRow!.latency_ms);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
