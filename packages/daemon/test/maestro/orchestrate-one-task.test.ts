import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { AgentDescriptor, ChainStartRequest } from "@penumbra/core";
import {
  loadSqliteVec,
  MaestroSessionWriter,
  migrate,
  TaskEventBus,
  TaskWriter,
} from "@penumbra/core";
import { orchestrateOneTask } from "../../src/maestro/orchestrate-one-task.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

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

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

test("orchestrateOneTask dispatches and creates session when no pre-bound session exists", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name) =>
      name === MAESTRO_AGENT.name
        ? MAESTRO_AGENT
        : name === SECOND_AGENT.name
          ? SECOND_AGENT
          : undefined,
  });

  const { task_id } = taskWriter.file({
    prompt: "Ship task 3.2",
    kind: "orchestrate",
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });

  const chainStartCalls: ChainStartRequest[] = [];
  const result = await orchestrateOneTask(task_id, {
    db,
    sessions,
    taskWriter,
    chainStart: async (req) => {
      chainStartCalls.push(req);
      return { handoff_id: "handoff-1", conversation_id: "conv-1" };
    },
    resolveAgent: (name) =>
      name === MAESTRO_AGENT.name
        ? MAESTRO_AGENT
        : name === SECOND_AGENT.name
          ? SECOND_AGENT
          : undefined,
    defaults: DEFAULT_BOUNDS,
  });

  expect(result.status).toBe("dispatched");
  if (result.status !== "dispatched") throw new Error("expected dispatched result");
  expect(result.agent_name).toBe(MAESTRO_AGENT.name);
  expect(result.chain_handoff_id).toBe("handoff-1");
  expect(result.conversation_id).toBe("conv-1");
  expect(result.session.task_id).toBe(task_id);

  expect(chainStartCalls).toHaveLength(1);
  expect(chainStartCalls[0]).toMatchObject({
    initial_agent: MAESTRO_AGENT.name,
    task_type: "implement_substantial",
    use_worktree: true,
    trust_mode: "all",
    dispatch_kind: "orchestrate",
  });

  const session = sessions.get(task_id);
  expect(session?.chain_handoff_id).toBe("handoff-1");
  expect(session?.agent_id).toBe(MAESTRO_AGENT.name);

  const task = taskWriter.get(task_id);
  expect(task.status).toBe("leased");
  db.close();
});

test("orchestrateOneTask dispatches a pre-bound session using session.agent_id", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name) =>
      name === MAESTRO_AGENT.name
        ? MAESTRO_AGENT
        : name === SECOND_AGENT.name
          ? SECOND_AGENT
          : undefined,
  });

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

  const chainStartCalls: ChainStartRequest[] = [];
  const result = await orchestrateOneTask(task_id, {
    db,
    sessions,
    taskWriter,
    chainStart: async (req) => {
      chainStartCalls.push(req);
      return { handoff_id: "handoff-prebound", conversation_id: "conv-prebound" };
    },
    resolveAgent: (name) =>
      name === MAESTRO_AGENT.name
        ? MAESTRO_AGENT
        : name === SECOND_AGENT.name
          ? SECOND_AGENT
          : undefined,
    defaults: DEFAULT_BOUNDS,
  });

  expect(result.status).toBe("dispatched");
  if (result.status !== "dispatched") throw new Error("expected dispatched result");
  expect(result.agent_name).toBe(MAESTRO_AGENT.name);
  expect(result.chain_handoff_id).toBe("handoff-prebound");
  expect(result.session.chain_handoff_id).toBe("handoff-prebound");
  expect(result.session.wall_clock_budget_ms).toBe(120_000);
  expect(result.session.cost_budget_cents).toBe(20);
  expect(result.session.sub_dispatch_budget).toBe(2);
  expect(chainStartCalls[0]?.initial_agent).toBe(MAESTRO_AGENT.name);

  db.close();
});

test("orchestrateOneTask leases for the full wall-clock budget, not the 90s default", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
  });

  const { task_id } = taskWriter.file({
    prompt: "Long-running orchestrate task",
    kind: "orchestrate",
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });

  const result = await orchestrateOneTask(task_id, {
    db,
    sessions,
    taskWriter,
    chainStart: async () => ({ handoff_id: "handoff-ttl", conversation_id: "conv-ttl" }),
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
    defaults: DEFAULT_BOUNDS,
  });

  expect(result.status).toBe("dispatched");

  // The lease must outlive the dispatch's own wall-clock budget so the 30s
  // lease-sweeper cannot reclaim the task mid-dispatch (was the 90s default,
  // ~20x shorter than the budget -> reclaimed + a false `lease expired` ledger row).
  const leaseRow = db
    .query<
      { claimed_at: number; expires_at: number },
      [string]
    >(`SELECT claimed_at, expires_at FROM task_leases WHERE task_id = ? AND released_at IS NULL`)
    .get(task_id);
  expect(leaseRow).not.toBeNull();
  const ttl = leaseRow!.expires_at - leaseRow!.claimed_at;
  expect(ttl).toBeGreaterThan(DEFAULT_BOUNDS.wall_clock_ms);
  db.close();
});

test("orchestrateOneTask: lease conflict short-circuits before chainStart is called", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
  });

  const { task_id } = taskWriter.file({
    prompt: "lease conflict task",
    kind: "orchestrate",
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });

  taskWriter.lease({
    task_id,
    agent_id: MAESTRO_AGENT.name,
    ttl_ms: 60_000,
  });

  const chainStartCalls: ChainStartRequest[] = [];
  const result = await orchestrateOneTask(task_id, {
    db,
    sessions,
    taskWriter,
    chainStart: async (req) => {
      chainStartCalls.push(req);
      return { handoff_id: "should-not-happen", conversation_id: "should-not-happen" };
    },
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
    defaults: DEFAULT_BOUNDS,
  });

  expect(chainStartCalls).toHaveLength(0);
  expect(result.status).toBe("short_circuited");
  if (result.status !== "short_circuited") throw new Error("expected short_circuited");
  expect(result.reason).toBe("already_dispatched");
  expect(sessions.get(task_id)).toBeNull();
  db.close();
});

test("orchestrateOneTask: chainStart succeeds but sessions.start throws -> chain cancelled and task not stuck leased", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
  });

  const { task_id } = taskWriter.file({
    prompt: "sessions.start failure task",
    kind: "orchestrate",
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });

  const cancelledHandoffs: string[] = [];
  let chainStartCallCount = 0;

  const result = await orchestrateOneTask(task_id, {
    db,
    sessions: {
      get: (id) => sessions.get(id),
      start: () => {
        throw new Error("db_write_failure");
      },
      markDispatched: (id, hid) => sessions.markDispatched(id, hid),
    } as unknown as MaestroSessionWriter,
    taskWriter,
    chainStart: async () => {
      chainStartCallCount++;
      return { handoff_id: "orphan-chain-handoff", conversation_id: "conv-orphan" };
    },
    chainCancel: async (handoff_id: string) => {
      cancelledHandoffs.push(handoff_id);
    },
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
    defaults: DEFAULT_BOUNDS,
  });

  expect(chainStartCallCount).toBe(1);
  expect(cancelledHandoffs).toEqual(["orphan-chain-handoff"]);
  expect(result.status).toBe("failed");
  const task = taskWriter.get(task_id);
  expect(task.status).toBe("failed");
  db.close();
});

test("orchestrateOneTask: chainStart fails -> compensation commits all four writes atomically", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
  });

  const { task_id } = taskWriter.file({
    prompt: "chain_start failure compensation",
    kind: "orchestrate",
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });
  // gh-link the task so enqueueGhStatusSyncOnDb actually writes a gh_outbox row
  // — exercises the third compensation write end-to-end.
  db.run(`UPDATE tasks SET gh_issue_number = 42, gh_issue_repo = 'owner/repo' WHERE id = ?`, [
    task_id,
  ]);

  const result = await orchestrateOneTask(task_id, {
    db,
    sessions,
    taskWriter,
    chainStart: async () => {
      throw new Error("chain start blew up");
    },
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
    defaults: DEFAULT_BOUNDS,
  });

  expect(result.status).toBe("failed");

  // 1) lease released with the chain_start_failed reason
  const leaseRow = db
    .query<
      { released_at: number | null; release_reason: string | null },
      [string]
    >(`SELECT released_at, release_reason FROM task_leases WHERE task_id = ?`)
    .get(task_id);
  expect(leaseRow?.released_at).not.toBeNull();
  expect(leaseRow?.release_reason).toBe("chain_start_failed");

  // 2) task reverted to pending
  expect(taskWriter.get(task_id).status).toBe("pending");

  // 3) gh status-sync push enqueued (gh-linked task)
  const ghRow = db
    .query<{ op: string }, [string]>(`SELECT op FROM gh_outbox WHERE task_id = ? AND op = ?`)
    .get(task_id, "gh_push_status");
  expect(ghRow?.op).toBe("gh_push_status");

  // 4) 'released' task_event recorded
  const releasedEvent = db
    .query<
      { payload_json: string | null },
      [string]
    >(`SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'released'`)
    .get(task_id);
  expect(releasedEvent).not.toBeNull();
  expect(JSON.parse(releasedEvent!.payload_json!).reason).toBe("chain_start_failed");

  db.close();
});

test("orchestrateOneTask: mid-compensation failure rolls back all four writes", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
  });

  const { task_id } = taskWriter.file({
    prompt: "mid-compensation rollback",
    kind: "orchestrate",
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });
  // gh-link so enqueueGhStatusSyncOnDb tries to INSERT into gh_outbox.
  db.run(`UPDATE tasks SET gh_issue_number = 7, gh_issue_repo = 'owner/repo' WHERE id = ?`, [
    task_id,
  ]);

  const result = await orchestrateOneTask(task_id, {
    db,
    sessions,
    taskWriter,
    chainStart: async () => {
      // Force the third compensation write (gh_outbox INSERT inside
      // enqueueGhStatusSyncOnDb) to throw by dropping the table after the
      // lease was acquired but before the catch block runs. The transaction
      // wrapping the four writes must then roll back the first two writes too.
      db.run(`DROP TABLE gh_outbox`);
      throw new Error("chain start blew up");
    },
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
    defaults: DEFAULT_BOUNDS,
  });

  expect(result.status).toBe("failed");

  // 1) lease NOT released — the rollback restored its open state.
  const leaseRow = db
    .query<
      { released_at: number | null; release_reason: string | null },
      [string]
    >(`SELECT released_at, release_reason FROM task_leases WHERE task_id = ?`)
    .get(task_id);
  expect(leaseRow?.released_at).toBeNull();
  expect(leaseRow?.release_reason).toBeNull();

  // 2) task NOT reverted to pending — the lease-TTL sweeper takes over.
  expect(taskWriter.get(task_id).status).toBe("leased");

  // 3) no 'released' task_event recorded.
  const releasedEvent = db
    .query<
      { id: number },
      [string]
    >(`SELECT id FROM task_events WHERE task_id = ? AND kind = 'released'`)
    .get(task_id);
  expect(releasedEvent).toBeNull();

  db.close();
});

test("orchestrateOneTask fails with unknown_agent when selected agent does not resolve", async () => {
  const db = setupDb();
  const taskWriter = new TaskWriter(db, {
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
  });
  const sessions = new MaestroSessionWriter({ db });
  const { task_id } = taskWriter.file({
    prompt: "unknown agent task",
    kind: "orchestrate",
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });

  const result = await orchestrateOneTask(task_id, {
    db,
    sessions,
    taskWriter,
    chainStart: async () => ({
      handoff_id: "should-not-happen",
      conversation_id: "should-not-happen",
    }),
    resolveAgent: () => undefined,
    defaults: DEFAULT_BOUNDS,
  });

  expect(result).toEqual({
    status: "failed",
    error: "unknown_agent",
    agent_name: MAESTRO_AGENT.name,
  });
  expect(sessions.get(task_id)).toBeNull();
  db.close();
});
