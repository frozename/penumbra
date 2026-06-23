import type { AgentDescriptor, ChainStartRequest } from "@penumbra/core";

import {
  loadSqliteVec,
  MaestroSessionWriter,
  migrate,
  TaskEventBus,
  TaskWriter,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";

import { createOrchestrateReactor } from "../../src/reactors/orchestrate-reactor.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

type ChainStartResult = { handoff_id: string; conversation_id: string };
type MaestroTerminateReason = Parameters<MaestroSessionWriter["terminate"]>[1];

const DEFAULT_BOUNDS = {
  wall_clock_ms: 1_800_000,
  cost_cents: 200,
  sub_dispatches: 10,
};

const MAESTRO_AGENT: AgentDescriptor = {
  name: "claude-acp-sonnet",
  maestro_capable: true,
  tags: ["typescript"],
  tier: "premium",
};

const SECOND_AGENT: AgentDescriptor = {
  name: "codex-acp-fast",
  maestro_capable: true,
  tags: ["typescript"],
  tier: "standard",
};

function resolveKnownAgent(name: string): AgentDescriptor | undefined {
  return name === MAESTRO_AGENT.name
    ? MAESTRO_AGENT
    : name === SECOND_AGENT.name
      ? SECOND_AGENT
      : undefined;
}

function resolveMaestroAgent(name: string): AgentDescriptor | undefined {
  return name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined;
}

function resolvedChainStartResult(
  handoffId: string,
  conversationId: string,
): Promise<ChainStartResult> {
  return Promise.resolve({ handoff_id: handoffId, conversation_id: conversationId });
}

function makeChainStartError(
  body: Record<string, unknown>,
): Error & { status: number; body: Record<string, unknown> } {
  const error = new Error(`chain_start failed (400): ${JSON.stringify(body)}`) as Error & {
    status: number;
    body: Record<string, unknown>;
  };
  error.status = 400;
  error.body = body;
  return error;
}

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() - started >= timeoutMs) {
        throw error;
      }
      await Bun.sleep(20);
    }
  }
}

afterEach((): Promise<void> => {
  // allow async iterator cleanup to settle between tests
  return Bun.sleep(5);
});

test("spawn happy path: creates session, leases task, calls chainStart, and records orchestrate_spawned", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: resolveKnownAgent,
  });

  const chainStartCalls: ChainStartRequest[] = [];
  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: (req) => {
      chainStartCalls.push(req);
      return resolvedChainStartResult("handoff-1", "conv-1");
    },
    resolveAgent: resolveKnownAgent,
    defaults: DEFAULT_BOUNDS,
  });
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: "Ship task 3.2",
    kind: "orchestrate",
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });

  await waitFor(() => {
    const session = sessions.get(task_id);
    expect(session).toBeTruthy();
    expect(session?.task_id).toBe(task_id);
  });

  const session = sessions.get(task_id);
  expect(session?.wall_clock_budget_ms).toBe(DEFAULT_BOUNDS.wall_clock_ms);
  expect(session?.cost_budget_cents).toBe(DEFAULT_BOUNDS.cost_cents);
  expect(session?.sub_dispatch_budget).toBe(DEFAULT_BOUNDS.sub_dispatches);
  expect(session?.agent_id).toBe(MAESTRO_AGENT.name);
  expect(session?.chain_handoff_id).toBe("handoff-1");

  expect(chainStartCalls).toHaveLength(1);
  expect(chainStartCalls[0]).toMatchObject({
    initial_agent: MAESTRO_AGENT.name,
    task_type: "implement_substantial",
    use_worktree: true,
    trust_mode: "all",
  });
  expect(chainStartCalls[0]?.message).toContain(`autonomous orchestrator for task ${task_id}`);

  const task = taskWriter.get(task_id);
  expect(task.status).toBe("leased");

  const spawned = db
    .query<
      { payload_json: string | null },
      [string]
    >(`SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_spawned' ORDER BY id DESC LIMIT 1`)
    .get(task_id);
  expect(spawned).toBeTruthy();
  const payload = JSON.parse(spawned?.payload_json ?? "{}") as {
    session_task_id?: string;
    chain_handoff_id?: string;
    bounds?: {
      wall_clock_budget_ms?: number;
      cost_budget_cents?: number;
      sub_dispatch_budget?: number;
    };
  };
  expect(payload.session_task_id).toBe(task_id);
  expect(payload.chain_handoff_id).toBe("handoff-1");
  expect(payload.bounds).toEqual({
    wall_clock_budget_ms: DEFAULT_BOUNDS.wall_clock_ms,
    cost_budget_cents: DEFAULT_BOUNDS.cost_cents,
    sub_dispatch_budget: DEFAULT_BOUNDS.sub_dispatches,
  });

  reactor.stop();
  db.close();
});

async function dispatchLeasedOrchestrateTask(opts: {
  db: Database;
  bus: TaskEventBus;
  sessions: MaestroSessionWriter;
  taskWriter: TaskWriter;
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}): Promise<{ reactor: ReturnType<typeof createOrchestrateReactor>; task_id: string }> {
  const reactor = createOrchestrateReactor({
    db: opts.db,
    bus: opts.bus,
    sessions: opts.sessions,
    taskWriter: opts.taskWriter,
    chainStart: () => resolvedChainStartResult("handoff-bk", "conv-bk"),
    resolveAgent: resolveMaestroAgent,
    defaults: DEFAULT_BOUNDS,
    ...(opts.log ? { log: opts.log } : {}),
  });
  reactor.start();
  const { task_id } = opts.taskWriter.file({
    prompt: "Backstop task",
    kind: "orchestrate",
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });
  await waitFor(() => {
    expect(opts.taskWriter.get(task_id).status).toBe("leased");
  });
  reactor.stop();
  return { reactor, task_id };
}

function insertTerminalHandoff(db: Database, status: string): void {
  db.run(
    `INSERT INTO handoffs(handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
     VALUES('handoff-bk', '2026-06-09T00:00:00Z', 'conv-bk', 'maestro', ?, 'msg', ?)`,
    [MAESTRO_AGENT.name, status],
  );
}

test("completion backstop: bounds per-tick batch and still reconciles remaining tasks on the next tick", () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: resolveMaestroAgent,
  });

  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: () => resolvedChainStartResult("handoff-batch", "conv-batch"),
    resolveAgent: resolveMaestroAgent,
    defaults: DEFAULT_BOUNDS,
  });

  // Synthesize 501 distinct orchestrate_spawned events for separate tasks
  // sharing a single terminal handoff. The query LIMIT (500) should bound the
  // first tick; the 501st row reconciles on the next call.
  const TOTAL = 501;
  const taskIds: string[] = [];
  for (let i = 0; i < TOTAL; i += 1) {
    const id = `synthetic-task-${String(i)}`;
    taskIds.push(id);
    db.run(
      `INSERT INTO tasks(id, kind, prompt, status, priority, created_by_kind, created_by_id, created_at, updated_at, eligibility, requires_review)
       VALUES (?, 'orchestrate', 'p', 'leased', 'normal', 'human', 'cli', 0, 0, '{}', 0)`,
      [id],
    );
    db.run(
      `INSERT INTO task_events (task_id, at, kind, actor, payload_json, maestro_session_task_id)
       VALUES (?, ?, 'orchestrate_spawned', NULL, ?, ?)`,
      [id, i, JSON.stringify({ chain_handoff_id: "handoff-batch" }), id],
    );
  }
  db.run(
    `INSERT INTO handoffs(handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
     VALUES('handoff-batch', '2026-06-09T00:00:00Z', 'conv-batch', 'maestro', ?, 'msg', 'completed')`,
    [MAESTRO_AGENT.name],
  );

  reactor.reconcileChainCompletions();
  const afterFirst = db
    .query<
      { n: number },
      []
    >("SELECT COUNT(*) AS n FROM task_events WHERE kind = 'orchestrate_terminated'")
    .get();
  expect(afterFirst?.n).toBe(500);

  reactor.reconcileChainCompletions();
  const afterSecond = db
    .query<
      { n: number },
      []
    >("SELECT COUNT(*) AS n FROM task_events WHERE kind = 'orchestrate_terminated'")
    .get();
  expect(afterSecond?.n).toBe(TOTAL);

  db.close();
});

test("completion backstop: still-leased task whose chain completed is failed, not inferred done", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: resolveMaestroAgent,
  });

  const { reactor, task_id } = await dispatchLeasedOrchestrateTask({
    db,
    bus,
    sessions,
    taskWriter,
  });

  // Chain reached a terminal 'completed' state but the agent never called
  // task.complete, so the task is still leased.
  insertTerminalHandoff(db, "completed");
  reactor.reconcileChainCompletions();

  const task = taskWriter.get(task_id);
  expect(task.status).toBe("failed");
  expect(task.failure_reason).toBe("chain_completed_without_self_completion");

  const terminated = db
    .query<
      { n: number },
      [string]
    >(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'orchestrate_terminated'`)
    .get(task_id);
  expect(terminated?.n).toBeGreaterThanOrEqual(1);
  // Lease released so the lease-sweeper cannot reclaim a now-terminal task.
  const openLease = db
    .query<
      { n: number },
      [string]
    >(`SELECT COUNT(*) AS n FROM task_leases WHERE task_id = ? AND released_at IS NULL`)
    .get(task_id);
  expect(openLease?.n).toBe(0);
  db.close();
});

test("completion backstop: still-leased task whose chain failed is failed with chain_failed", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: resolveMaestroAgent,
  });

  const { reactor, task_id } = await dispatchLeasedOrchestrateTask({
    db,
    bus,
    sessions,
    taskWriter,
  });

  insertTerminalHandoff(db, "failed");
  reactor.reconcileChainCompletions();

  const task = taskWriter.get(task_id);
  expect(task.status).toBe("failed");
  expect(task.failure_reason).toBe("chain_failed");
  db.close();
});

test("completion backstop: logs and retries recordTerminated failures", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: resolveMaestroAgent,
  });

  const failOnce = new Error("terminate busy");
  const originalTerminate: MaestroSessionWriter["terminate"] = sessions.terminate.bind(sessions);
  let terminateCalls = 0;
  sessions.terminate = (taskId: string, reason: MaestroTerminateReason): void => {
    terminateCalls += 1;
    if (terminateCalls === 1) throw failOnce;
    originalTerminate(taskId, reason);
  };

  const warnCalls: [Record<string, unknown>, string][] = [];
  const { reactor, task_id } = await dispatchLeasedOrchestrateTask({
    db,
    bus,
    sessions,
    taskWriter,
    log: {
      warn: (obj: Record<string, unknown>, msg: string): void => {
        warnCalls.push([obj, msg]);
      },
    },
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  insertTerminalHandoff(db, "completed");
  process.on("unhandledRejection", onUnhandled);
  try {
    reactor.reconcileChainCompletions();
    await Bun.sleep(20);

    expect(unhandled).toEqual([]);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]?.[0]).toMatchObject({ err: failOnce, task_id });
    expect(warnCalls[0]?.[1]).toBe("reconcile recordTerminated backstop failed");

    let terminated = db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'orchestrate_terminated'`)
      .get(task_id);
    expect(terminated?.n).toBe(0);

    reactor.reconcileChainCompletions();
    terminated = db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'orchestrate_terminated'`)
      .get(task_id);
    expect(terminated?.n).toBe(1);
    expect(taskWriter.get(task_id).status).toBe("failed");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    db.close();
  }
});

test("completion backstop: leaves a task the agent already self-completed untouched", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: resolveMaestroAgent,
  });

  const { reactor, task_id } = await dispatchLeasedOrchestrateTask({
    db,
    bus,
    sessions,
    taskWriter,
  });

  // Agent self-completed the task before the backstop runs.
  const lease = taskWriter.get(task_id, { include: ["lease"] }).lease;
  expect(lease).toBeTruthy();
  taskWriter.complete({ task_id, lease_id: lease!.id, result_summary: "agent did the work" });
  expect(taskWriter.get(task_id).status).toBe("done");

  insertTerminalHandoff(db, "completed");
  reactor.reconcileChainCompletions();

  // Backstop must not override the agent's own verdict.
  expect(taskWriter.get(task_id).status).toBe("done");
  db.close();
});

test("pre-bound session with null chain_handoff_id dispatches using session.agent_id", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: resolveKnownAgent,
  });

  const chainStartCalls: ChainStartRequest[] = [];
  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: (req) => {
      chainStartCalls.push(req);
      return resolvedChainStartResult("handoff-prebound", "conv-prebound");
    },
    resolveAgent: resolveKnownAgent,
    defaults: DEFAULT_BOUNDS,
  });
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: "Ship prebound task",
    kind: "orchestrate",
    eligibility: { allow_agents: [SECOND_AGENT.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });
  sessions.start({
    task_id,
    agent_id: MAESTRO_AGENT.name,
    wall_clock_budget_ms: 120_000,
    cost_budget_cents: 20,
    sub_dispatch_budget: 2,
  });
  bus.publish({
    task_id,
    at: Date.now(),
    kind: "filed",
    actor: null,
    payload: null,
  });

  await waitFor(() => {
    expect(chainStartCalls).toHaveLength(1);
    expect(sessions.get(task_id)?.chain_handoff_id).toBe("handoff-prebound");
  });
  expect(chainStartCalls[0]?.initial_agent).toBe(MAESTRO_AGENT.name);

  reactor.stop();
  db.close();
});

test("pre-bound session with non-null chain_handoff_id short-circuits dispatch", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: resolveKnownAgent,
  });

  const chainStartCalls: ChainStartRequest[] = [];
  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: (req) => {
      chainStartCalls.push(req);
      return resolvedChainStartResult("handoff-ignored", "conv-ignored");
    },
    resolveAgent: resolveKnownAgent,
    defaults: DEFAULT_BOUNDS,
  });
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: "Ship prebound-dispatched task",
    kind: "orchestrate",
    eligibility: { allow_agents: [SECOND_AGENT.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });
  sessions.start({
    task_id,
    chain_handoff_id: "handoff-already",
    agent_id: MAESTRO_AGENT.name,
    wall_clock_budget_ms: 120_000,
    cost_budget_cents: 20,
    sub_dispatch_budget: 2,
  });
  bus.publish({
    task_id,
    at: Date.now(),
    kind: "filed",
    actor: null,
    payload: null,
  });

  await Bun.sleep(100);
  expect(chainStartCalls).toHaveLength(0);
  expect(sessions.get(task_id)?.chain_handoff_id).toBe("handoff-already");

  reactor.stop();
  db.close();
});

test("idempotent on event replay: duplicate filed event does not create duplicate session or chain start", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: resolveMaestroAgent,
  });

  const chainStartCalls: ChainStartRequest[] = [];
  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: (req) => {
      chainStartCalls.push(req);
      return resolvedChainStartResult("handoff-1", "conv-1");
    },
    resolveAgent: resolveMaestroAgent,
    defaults: DEFAULT_BOUNDS,
  });
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: "Ship task 3.2",
    kind: "orchestrate",
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });

  await waitFor(() => {
    expect(chainStartCalls).toHaveLength(1);
  });

  const filed = db
    .query<
      { at: number; actor: string | null },
      [string]
    >(`SELECT at, actor FROM task_events WHERE task_id = ? AND kind = 'filed' ORDER BY id ASC LIMIT 1`)
    .get(task_id);
  expect(filed).toBeTruthy();

  bus.publish({
    task_id,
    at: filed?.at ?? Date.now(),
    kind: "filed",
    actor: filed?.actor ?? null,
    payload: null,
  });

  await Bun.sleep(100);

  expect(chainStartCalls).toHaveLength(1);
  const count = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM maestro_sessions WHERE task_id = ?")
    .get(task_id);
  expect(count?.n).toBe(1);

  reactor.stop();
  db.close();
});

test("chainStart rejects: records orchestrate_terminated, no session, task remains pending", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: resolveMaestroAgent,
  });

  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: () => Promise.reject(new Error("boom")),
    resolveAgent: resolveMaestroAgent,
    defaults: DEFAULT_BOUNDS,
  });
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: "Ship task 3.2",
    kind: "orchestrate",
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });

  await waitFor(() => {
    const terminated = db
      .query<
        { payload_json: string | null },
        [string]
      >(`SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_terminated' ORDER BY id DESC LIMIT 1`)
      .get(task_id);
    expect(terminated).toBeTruthy();
  });

  expect(sessions.get(task_id)).toBeNull();
  const task = taskWriter.get(task_id);
  expect(task.status).toBe("pending");

  const terminated = db
    .query<
      { payload_json: string | null },
      [string]
    >(`SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_terminated' ORDER BY id DESC LIMIT 1`)
    .get(task_id);
  const payload = JSON.parse(terminated?.payload_json ?? "{}") as {
    reason?: string;
    error?: string;
  };
  expect(payload.reason).toBe("failed");
  expect(payload.error).toContain("Error: boom");

  reactor.stop();
  db.close();
});

test("subscription_pressure_capped with future earliest_resets_at records orchestrate_deferred", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const nowMs = new Date("2026-05-08T02:00:00Z").getTime();
  const taskWriter = new TaskWriter(db, {
    now: (): number => nowMs,
    bus,
    resolveAgent: resolveMaestroAgent,
  });

  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: () =>
      Promise.reject(
        makeChainStartError({
          error: {
            code: "subscription_pressure_capped",
            provider: "openai",
            window_label: "five_hour",
            earliest_resets_at: nowMs + 60_000,
          },
        }),
      ),
    resolveAgent: resolveMaestroAgent,
    defaults: DEFAULT_BOUNDS,
    now: (): number => nowMs,
  });
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: "Ship task 3.2",
    kind: "orchestrate",
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });

  await waitFor(() => {
    const deferred = db
      .query<
        { payload_json: string | null },
        [string]
      >(`SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_deferred' ORDER BY id DESC LIMIT 1`)
      .get(task_id);
    expect(deferred).toBeTruthy();
  });

  const deferred = db
    .query<
      { payload_json: string | null },
      [string]
    >(`SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_deferred' ORDER BY id DESC LIMIT 1`)
    .get(task_id);
  const terminatedCount = db
    .query<
      { n: number },
      [string]
    >(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'orchestrate_terminated'`)
    .get(task_id);
  const payload = JSON.parse(deferred?.payload_json ?? "{}") as {
    reason?: string;
    resume_at_ms?: number;
    provider?: string;
    window_label?: string;
    original_error?: string;
  };

  expect(terminatedCount?.n ?? 0).toBe(0);
  expect(payload.reason).toBe("subscription_pressure_capped");
  expect(payload.resume_at_ms).toBe(nowMs + 60_000);
  expect(payload.provider).toBe("openai");
  expect(payload.window_label).toBe("five_hour");
  expect(payload.original_error).toBeTruthy();

  reactor.stop();
  db.close();
});

test("subscription_pressure_capped with null earliest_resets_at records orchestrate_terminated", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: resolveMaestroAgent,
  });

  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: () =>
      Promise.reject(
        makeChainStartError({
          error: {
            code: "subscription_pressure_capped",
            provider: "openai",
            window_label: "five_hour",
            earliest_resets_at: null,
          },
        }),
      ),
    resolveAgent: resolveMaestroAgent,
    defaults: DEFAULT_BOUNDS,
  });
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: "Ship task 3.2",
    kind: "orchestrate",
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });

  await waitFor(() => {
    const terminated = db
      .query<
        { payload_json: string | null },
        [string]
      >(`SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_terminated' ORDER BY id DESC LIMIT 1`)
      .get(task_id);
    expect(terminated).toBeTruthy();
  });

  const deferredCount = db
    .query<
      { n: number },
      [string]
    >(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'orchestrate_deferred'`)
    .get(task_id);
  expect(deferredCount?.n ?? 0).toBe(0);

  reactor.stop();
  db.close();
});

test("per-task bounds override defaults", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: resolveMaestroAgent,
  });

  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: () => resolvedChainStartResult("handoff-2", "conv-2"),
    resolveAgent: resolveMaestroAgent,
    defaults: DEFAULT_BOUNDS,
  });
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: "Ship task 3.2",
    kind: "orchestrate",
    bounds: { wall_clock_ms: 60_000 },
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });

  await waitFor(() => {
    expect(sessions.get(task_id)).toBeTruthy();
  });

  const session = sessions.get(task_id);
  expect(session?.wall_clock_budget_ms).toBe(60_000);
  expect(session?.cost_budget_cents).toBe(DEFAULT_BOUNDS.cost_cents);
  expect(session?.sub_dispatch_budget).toBe(DEFAULT_BOUNDS.sub_dispatches);

  reactor.stop();
  db.close();
});

test("unknown agent in allow_agents: terminates without spawning", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: resolveMaestroAgent,
  });

  const chainStartCalls: ChainStartRequest[] = [];
  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: (req) => {
      chainStartCalls.push(req);
      return resolvedChainStartResult("handoff-3", "conv-3");
    },
    resolveAgent: () => undefined,
    defaults: DEFAULT_BOUNDS,
  });
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: "Ship task 3.2",
    kind: "orchestrate",
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });

  await waitFor(() => {
    const terminated = db
      .query<
        { payload_json: string | null },
        [string]
      >(`SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_terminated' ORDER BY id DESC LIMIT 1`)
      .get(task_id);
    expect(terminated).toBeTruthy();
  });

  expect(sessions.get(task_id)).toBeNull();
  expect(chainStartCalls).toHaveLength(0);

  const terminated = db
    .query<
      { payload_json: string | null },
      [string]
    >(`SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_terminated' ORDER BY id DESC LIMIT 1`)
    .get(task_id);
  const payload = JSON.parse(terminated?.payload_json ?? "{}") as {
    reason?: string;
    error?: string;
    agent_name?: string;
  };
  expect(payload.reason).toBe("failed");
  expect(payload.error).toBe("unknown_agent");
  expect(payload.agent_name).toBe(MAESTRO_AGENT.name);

  reactor.stop();
  db.close();
});

test("non-orchestrate task is ignored", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: resolveMaestroAgent,
  });

  const chainStartCalls: ChainStartRequest[] = [];
  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: (req) => {
      chainStartCalls.push(req);
      return resolvedChainStartResult("handoff-4", "conv-4");
    },
    resolveAgent: resolveMaestroAgent,
    defaults: DEFAULT_BOUNDS,
  });
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: "regular work item",
    kind: "work",
    created_by_kind: "human",
    created_by_id: "cli",
  });

  await Bun.sleep(100);

  expect(sessions.get(task_id)).toBeNull();
  expect(chainStartCalls).toHaveLength(0);

  const spawnedCount = db
    .query<
      { n: number },
      [string]
    >(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'orchestrate_spawned'`)
    .get(task_id);
  expect(spawnedCount?.n).toBe(0);

  reactor.stop();
  db.close();
});
