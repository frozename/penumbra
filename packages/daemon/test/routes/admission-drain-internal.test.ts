import {
  type AgentDescriptor,
  buildServices,
  loadSqliteVec,
  MaestroSessionWriter,
  migrate,
  type Services,
  TaskEventBus,
  TaskWriter,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOrchestrateReactor } from "@src/reactors/orchestrate-reactor.js";
import { readAdmissionDrain } from "@src/routes/admission-drain.js";
import { chainStartInternal } from "@src/routes/chains.js";
import { chainStartForOrchestrate, spawnLongLivedTick } from "@src/serve.js";
import { createWorkflowRunsRegistry } from "@src/services/workflow-runs-registry.js";
import { runOrchestrateDeferralSweep } from "@src/sweepers/orchestrate-deferral.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

beforeAll(() => {
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
});

const START_MS = new Date("2026-11-17T12:00:00.000Z").getTime();
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DRAIN_REMAINING_MS = 2 * MINUTE_MS;

const ORCHESTRATOR: AgentDescriptor = {
  name: "codex",
  maestro_capable: true,
  tags: ["typescript"],
  tier: "standard",
};

interface Ctx {
  db: Database;
  storageRoot: string;
  services: Services;
  clock: { ms: number };
}

const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await Bun.sleep(5);
});

function setup(): Ctx {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const storageRoot = mkdtempSync(join(tmpdir(), "penumbra-admission-drain-internal-"));
  const worktreeRootDir = join(storageRoot, "worktrees");
  mkdirSync(worktreeRootDir, { recursive: true });
  const clock = { ms: START_MS };
  let n = 0;
  const workflowRuns = createWorkflowRunsRegistry({
    uuid: () => `wf-run-${String(++n)}`,
    clock: () => new Date(clock.ms),
    db,
    storageRoot,
  });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot,
    worktreeRootDir,
    mainRepoDir: join(storageRoot, "main"),
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date(clock.ms),
    uuid: () => `id-${String(++n)}`,
    agentRegistry: ["codex", "home"],
    workflowRuns,
  });
  services.watchdog = {
    recordHeartbeat: (): void => undefined,
    hasActiveWorker: (): boolean => true,
    getStaleWorkers: (): never[] => [],
    getStaleHeartbeatAges: (): never[] => [],
    tick: (): Promise<void> => Promise.resolve(),
  };
  services.agentchatConfig = {
    agents: [
      { name: "codex", roles: [] },
      { name: "home", roles: [] },
    ],
  };
  cleanups.push(() => {
    try {
      services.supervisor.stopAll();
    } catch {
      /* already stopped */
    }
    db.close();
    rmSync(storageRoot, { recursive: true, force: true });
  });
  return { db, storageRoot, services, clock };
}

function flagPath(ctx: Ctx): string {
  return join(ctx.storageRoot, "admission-drain.json");
}

function setDrain(ctx: Ctx, setAtMs: number = ctx.clock.ms - MINUTE_MS): void {
  writeFileSync(
    flagPath(ctx),
    JSON.stringify({
      owner: "deploy-a",
      reason: "deploy",
      set_at: new Date(setAtMs).toISOString(),
      expires_at: new Date(ctx.clock.ms + DRAIN_REMAINING_MS).toISOString(),
    }),
  );
}

function releaseDrain(ctx: Ctx): void {
  rmSync(flagPath(ctx), { force: true });
}

function countHandoffs(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM handoffs").get()?.n ?? 0;
}

async function errorCode(res: Response): Promise<string | undefined> {
  const body = (await res.clone().json()) as { error?: { code?: string } };
  return body.error?.code;
}

async function expectDraining(res: Response): Promise<void> {
  expect(res.status).toBe(503);
  const body = (await res.json()) as {
    error?: { code?: string; retryable?: boolean };
    retry_after_ms?: number;
  };
  expect(body.error?.code).toBe("admission_draining");
  expect(body.error?.retryable).toBe(true);
  expect(body.retry_after_ms).toBe(DRAIN_REMAINING_MS);
}

function freshStart(services: Services, extra: Record<string, unknown> = {}): Promise<Response> {
  return chainStartInternal(
    { initial_agent: "codex", message: "fresh", project_id: "penumbra", ...extra },
    services,
  );
}

function seedParent(ctx: Ctx, status: "dispatched" | "completed"): void {
  ctx.services.handoffWriter.createApproved({
    handoff_id: "h-parent",
    ts: new Date(ctx.clock.ms - 2 * MINUTE_MS).toISOString(),
    project_id: "penumbra",
    conversation_id: "conv-parent",
    from: "user",
    to: "codex",
    to_role: null,
    message: "parent",
    triggered_by_event_id: "evt-parent",
    resolved_by: "chain-start",
    resolved_at: null,
    chain_max_hops: 3,
    chain_trust_mode: "all",
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
  });
  ctx.db.run("UPDATE handoffs SET status=? WHERE handoff_id=?", [status, "h-parent"]);
}

test("chainStartInternal refuses fresh work while draining and admits it after release", async () => {
  const ctx = setup();
  setDrain(ctx);
  await expectDraining(await freshStart(ctx.services));
  expect(countHandoffs(ctx.db)).toBe(0);

  releaseDrain(ctx);
  const res = await freshStart(ctx.services);
  expect(res.status).toBe(200);
  expect(countHandoffs(ctx.db)).toBe(1);
});

test("chainStartInternal admits a child of a dispatched parent while draining", async () => {
  const ctx = setup();
  seedParent(ctx, "dispatched");
  setDrain(ctx);
  const res = await freshStart(ctx.services, { parent_handoff_id: "h-parent" });
  expect(await errorCode(res)).not.toBe("admission_draining");
  expect(res.status).toBe(200);
});

test("chainStartInternal refuses a child of a completed parent while draining", async () => {
  const ctx = setup();
  seedParent(ctx, "completed");
  setDrain(ctx);
  await expectDraining(await freshStart(ctx.services, { parent_handoff_id: "h-parent" }));
});

test("chainStartInternal admits steps of a workflow run registered before the drain", async () => {
  const ctx = setup();
  const runId = ctx.services.workflowRuns?.register("wf", "penumbra") ?? null;
  expect(runId).not.toBeNull();
  ctx.clock.ms += 2 * MINUTE_MS;
  setDrain(ctx, START_MS + MINUTE_MS);
  const res = await freshStart(ctx.services, {
    dispatch_kind: "workflow",
    workflow_run_id: runId,
  });
  expect(await errorCode(res)).not.toBe("admission_draining");
});

test("chainStartInternal refuses steps of a workflow run registered during the drain", async () => {
  const ctx = setup();
  setDrain(ctx);
  ctx.clock.ms += 1_000;
  const runId = ctx.services.workflowRuns?.register("wf", "penumbra") ?? null;
  expect(runId).not.toBeNull();
  const res = await freshStart(ctx.services, {
    dispatch_kind: "workflow",
    workflow_run_id: runId,
  });
  expect(res.status).toBe(503);
  expect(await errorCode(res)).toBe("admission_draining");
});

test("chainStartInternal refuses a non-workflow start naming a pre-drain workflow run", async () => {
  const ctx = setup();
  const runId = ctx.services.workflowRuns?.register("wf", "penumbra") ?? null;
  expect(runId).not.toBeNull();
  ctx.clock.ms += 2 * MINUTE_MS;
  setDrain(ctx, START_MS + MINUTE_MS);
  await expectDraining(await freshStart(ctx.services, { workflow_run_id: runId }));
  await expectDraining(
    await freshStart(ctx.services, { dispatch_kind: "orchestrate", workflow_run_id: runId }),
  );
  expect(countHandoffs(ctx.db)).toBe(0);
});

function seedLongLivedTick(ctx: Ctx, tickId: string): void {
  ctx.db.run(
    `INSERT OR IGNORE INTO long_lived_agents
       (id, display_name, project_id, working_memory_json, standing_brief, created_at, updated_at)
     VALUES ('home', 'Home', 'penumbra', ?, 'watch', ?, ?)`,
    [
      JSON.stringify({
        version: 1,
        updated_at: ctx.clock.ms,
        pending_goals: [],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      }),
      ctx.clock.ms,
      ctx.clock.ms,
    ],
  );
  ctx.db.run(
    `INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at)
     VALUES (?, 'home', 'cron', ?)`,
    [tickId, ctx.clock.ms],
  );
}

test("long-lived cron tick spawn is refused while draining and spawns after release", async () => {
  const ctx = setup();
  seedLongLivedTick(ctx, "tick-1");
  setDrain(ctx);
  let caught: unknown = null;
  try {
    await spawnLongLivedTick(ctx.services, { agent_id: "home", tick_id: "tick-1" });
  } catch (error) {
    caught = error;
  }
  expect(String(caught)).toContain("503");
  expect(String(caught)).toContain("admission_draining");
  expect(countHandoffs(ctx.db)).toBe(0);

  releaseDrain(ctx);
  seedLongLivedTick(ctx, "tick-2");
  const spawned = await spawnLongLivedTick(ctx.services, { agent_id: "home", tick_id: "tick-2" });
  expect(typeof spawned.chain_id).toBe("string");
  expect(countHandoffs(ctx.db)).toBe(1);
});

async function waitFor(assertion: () => void, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - started >= timeoutMs) throw error;
      await Bun.sleep(10);
    }
  }
}

function taskEvent(
  db: Database,
  taskId: string,
  kind: string,
): { payload_json: string | null } | null {
  return db
    .query<
      { payload_json: string | null },
      [string, string]
    >("SELECT payload_json FROM task_events WHERE task_id = ? AND kind = ? ORDER BY id DESC LIMIT 1")
    .get(taskId, kind);
}

test("orchestrate reactor defers a filed task while draining and dispatches it after release", async () => {
  const ctx = setup();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db: ctx.db });
  const resolveAgent = (name: string): AgentDescriptor | undefined =>
    name === ORCHESTRATOR.name ? ORCHESTRATOR : undefined;
  const taskWriter = new TaskWriter(ctx.db, { bus, resolveAgent });
  const reactor = createOrchestrateReactor({
    db: ctx.db,
    bus,
    sessions,
    taskWriter,
    chainStart: (req) => chainStartForOrchestrate(ctx.services, req),
    resolveAgent,
    defaults: { wall_clock_ms: 1_800_000, cost_cents: 200, sub_dispatches: 10 },
    now: () => ctx.clock.ms,
  });
  cleanups.unshift(() => {
    reactor.stop();
  });
  setDrain(ctx);
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: "ship it",
    project_id: "penumbra",
    kind: "orchestrate",
    eligibility: { allow_agents: [ORCHESTRATOR.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });

  await waitFor(() => {
    expect(taskEvent(ctx.db, task_id, "orchestrate_deferred")).not.toBeNull();
  });
  const deferred = JSON.parse(
    taskEvent(ctx.db, task_id, "orchestrate_deferred")?.payload_json ?? "{}",
  ) as { reason?: string; resume_at_ms?: number };
  expect(deferred.reason).toBe("admission_draining");
  expect(deferred.resume_at_ms).toBe(ctx.clock.ms + DRAIN_REMAINING_MS);
  expect(taskEvent(ctx.db, task_id, "orchestrate_spawned")).toBeNull();
  expect(taskEvent(ctx.db, task_id, "orchestrate_terminated")).toBeNull();
  expect(taskWriter.get(task_id).status).toBe("pending");
  expect(countHandoffs(ctx.db)).toBe(0);

  releaseDrain(ctx);
  ctx.clock.ms += DRAIN_REMAINING_MS;
  const sweep = runOrchestrateDeferralSweep({ db: ctx.db, bus, now: () => ctx.clock.ms });
  expect(sweep.resumed).toEqual([task_id]);
  await waitFor(() => {
    expect(taskEvent(ctx.db, task_id, "orchestrate_spawned")).not.toBeNull();
  });
  expect(countHandoffs(ctx.db)).toBe(1);
});

test("a drain flag with set_at in the future is invalid and does not gate", async () => {
  const ctx = setup();
  writeFileSync(
    flagPath(ctx),
    JSON.stringify({
      owner: "deploy-a",
      reason: "deploy",
      set_at: new Date(ctx.clock.ms + 365 * DAY_MS).toISOString(),
      expires_at: new Date(ctx.clock.ms + 730 * DAY_MS).toISOString(),
    }),
  );
  expect(readAdmissionDrain(ctx.storageRoot, new Date(ctx.clock.ms))).toEqual({
    draining: false,
    invalid: true,
  });
  ctx.clock.ms += 120 * MINUTE_MS;
  expect(readAdmissionDrain(ctx.storageRoot, new Date(ctx.clock.ms))).toEqual({
    draining: false,
    invalid: true,
  });
  const res = await freshStart(ctx.services);
  expect(await errorCode(res)).not.toBe("admission_draining");
});
