import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { AgentDescriptor, ChainStartRequest } from '@penumbra/core';
import {
  loadSqliteVec,
  MaestroSessionWriter,
  migrate,
  TaskEventBus,
  TaskWriter,
} from '@penumbra/core';
import { createOrchestrateReactor } from '../../src/reactors/orchestrate-reactor.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

const DEFAULT_BOUNDS = {
  wall_clock_ms: 1_800_000,
  cost_cents: 200,
  sub_dispatches: 10,
};

const MAESTRO_AGENT: AgentDescriptor = {
  name: 'claude-acp-sonnet',
  maestro_capable: true,
  tags: ['typescript'],
  tier: 'premium',
};

function makeChainStartError(body: Record<string, unknown>): Error & { status: number; body: Record<string, unknown> } {
  const error = new Error(`chain_start failed (400): ${JSON.stringify(body)}`) as Error & {
    status: number;
    body: Record<string, unknown>;
  };
  error.status = 400;
  error.body = body;
  return error;
}

function setupDb(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (true) {
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

afterEach(() => {
  // allow async iterator cleanup to settle between tests
  return Bun.sleep(5);
});

test('spawn happy path: creates session, leases task, calls chainStart, and records orchestrate_spawned', async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
  });

  const chainStartCalls: ChainStartRequest[] = [];
  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: async (req) => {
      chainStartCalls.push(req);
      return { handoff_id: 'handoff-1', conversation_id: 'conv-1' };
    },
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
    defaults: DEFAULT_BOUNDS,
  });
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: 'Ship task 3.2',
    kind: 'orchestrate',
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: 'human',
    created_by_id: 'cli',
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
  expect(session?.chain_handoff_id).toBe('handoff-1');

  expect(chainStartCalls).toHaveLength(1);
  expect(chainStartCalls[0]).toMatchObject({
    initial_agent: MAESTRO_AGENT.name,
    task_type: 'implement_substantial',
    use_worktree: true,
    trust_mode: 'all',
  });
  expect(chainStartCalls[0]?.message).toContain(`autonomous orchestrator for task ${task_id}`);

  const task = taskWriter.get(task_id);
  expect(task.status).toBe('leased');

  const spawned = db
    .query<{ payload_json: string | null }, [string]>(
      `SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_spawned' ORDER BY id DESC LIMIT 1`,
    )
    .get(task_id);
  expect(spawned).toBeTruthy();
  const payload = JSON.parse(spawned?.payload_json ?? '{}') as {
    session_task_id?: string;
    chain_handoff_id?: string;
    bounds?: { wall_clock_budget_ms?: number; cost_budget_cents?: number; sub_dispatch_budget?: number };
  };
  expect(payload.session_task_id).toBe(task_id);
  expect(payload.chain_handoff_id).toBe('handoff-1');
  expect(payload.bounds).toEqual({
    wall_clock_budget_ms: DEFAULT_BOUNDS.wall_clock_ms,
    cost_budget_cents: DEFAULT_BOUNDS.cost_cents,
    sub_dispatch_budget: DEFAULT_BOUNDS.sub_dispatches,
  });

  reactor.stop();
  db.close();
});

test('idempotent on event replay: duplicate filed event does not create duplicate session or chain start', async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
  });

  const chainStartCalls: ChainStartRequest[] = [];
  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: async (req) => {
      chainStartCalls.push(req);
      return { handoff_id: 'handoff-1', conversation_id: 'conv-1' };
    },
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
    defaults: DEFAULT_BOUNDS,
  });
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: 'Ship task 3.2',
    kind: 'orchestrate',
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: 'human',
    created_by_id: 'cli',
  });

  await waitFor(() => {
    expect(chainStartCalls).toHaveLength(1);
  });

  const filed = db
    .query<{ at: number; actor: string | null }, [string]>(
      `SELECT at, actor FROM task_events WHERE task_id = ? AND kind = 'filed' ORDER BY id ASC LIMIT 1`,
    )
    .get(task_id);
  expect(filed).toBeTruthy();

  bus.publish({
    task_id,
    at: filed?.at ?? Date.now(),
    kind: 'filed',
    actor: filed?.actor ?? null,
    payload: null,
  });

  await Bun.sleep(100);

  expect(chainStartCalls).toHaveLength(1);
  const count = db
    .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM maestro_sessions WHERE task_id = ?')
    .get(task_id);
  expect(count?.n).toBe(1);

  reactor.stop();
  db.close();
});

test('chainStart rejects: records orchestrate_terminated, no session, task remains pending', async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
  });

  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: async () => {
      throw new Error('boom');
    },
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
    defaults: DEFAULT_BOUNDS,
  });
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: 'Ship task 3.2',
    kind: 'orchestrate',
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: 'human',
    created_by_id: 'cli',
  });

  await waitFor(() => {
    const terminated = db
      .query<{ payload_json: string | null }, [string]>(
        `SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_terminated' ORDER BY id DESC LIMIT 1`,
      )
      .get(task_id);
    expect(terminated).toBeTruthy();
  });

  expect(sessions.get(task_id)).toBeNull();
  const task = taskWriter.get(task_id);
  expect(task.status).toBe('pending');

  const terminated = db
    .query<{ payload_json: string | null }, [string]>(
      `SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_terminated' ORDER BY id DESC LIMIT 1`,
    )
    .get(task_id);
  const payload = JSON.parse(terminated?.payload_json ?? '{}') as { reason?: string; error?: string };
  expect(payload.reason).toBe('failed');
  expect(payload.error).toContain('Error: boom');

  reactor.stop();
  db.close();
});

test('subscription_pressure_capped with future earliest_resets_at records orchestrate_deferred', async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const nowMs = new Date('2026-05-08T02:00:00Z').getTime();
  const taskWriter = new TaskWriter(db, {
    now: () => nowMs,
    bus,
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
  });

  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: async () => {
      throw makeChainStartError({
        error: {
          code: 'subscription_pressure_capped',
          provider: 'openai',
          window_label: 'five_hour',
          earliest_resets_at: nowMs + 60_000,
        },
      });
    },
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
    defaults: DEFAULT_BOUNDS,
    now: () => nowMs,
  });
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: 'Ship task 3.2',
    kind: 'orchestrate',
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: 'human',
    created_by_id: 'cli',
  });

  await waitFor(() => {
    const deferred = db
      .query<{ payload_json: string | null }, [string]>(
        `SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_deferred' ORDER BY id DESC LIMIT 1`,
      )
      .get(task_id);
    expect(deferred).toBeTruthy();
  });

  const deferred = db
    .query<{ payload_json: string | null }, [string]>(
      `SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_deferred' ORDER BY id DESC LIMIT 1`,
    )
    .get(task_id);
  const terminatedCount = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'orchestrate_terminated'`,
    )
    .get(task_id);
  const payload = JSON.parse(deferred?.payload_json ?? '{}') as {
    reason?: string;
    resume_at_ms?: number;
    provider?: string;
    window_label?: string;
    original_error?: string;
  };

  expect(terminatedCount?.n ?? 0).toBe(0);
  expect(payload.reason).toBe('subscription_pressure_capped');
  expect(payload.resume_at_ms).toBe(nowMs + 60_000);
  expect(payload.provider).toBe('openai');
  expect(payload.window_label).toBe('five_hour');
  expect(payload.original_error).toBeTruthy();

  reactor.stop();
  db.close();
});

test('subscription_pressure_capped with null earliest_resets_at records orchestrate_terminated', async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
  });

  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: async () => {
      throw makeChainStartError({
        error: {
          code: 'subscription_pressure_capped',
          provider: 'openai',
          window_label: 'five_hour',
          earliest_resets_at: null,
        },
      });
    },
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
    defaults: DEFAULT_BOUNDS,
  });
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: 'Ship task 3.2',
    kind: 'orchestrate',
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: 'human',
    created_by_id: 'cli',
  });

  await waitFor(() => {
    const terminated = db
      .query<{ payload_json: string | null }, [string]>(
        `SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_terminated' ORDER BY id DESC LIMIT 1`,
      )
      .get(task_id);
    expect(terminated).toBeTruthy();
  });

  const deferredCount = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'orchestrate_deferred'`,
    )
    .get(task_id);
  expect(deferredCount?.n ?? 0).toBe(0);

  reactor.stop();
  db.close();
});

test('per-task bounds override defaults', async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
  });

  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: async () => ({ handoff_id: 'handoff-2', conversation_id: 'conv-2' }),
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
    defaults: DEFAULT_BOUNDS,
  });
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: 'Ship task 3.2',
    kind: 'orchestrate',
    bounds: { wall_clock_ms: 60_000 },
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: 'human',
    created_by_id: 'cli',
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

test('unknown agent in allow_agents: terminates without spawning', async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
  });

  const chainStartCalls: ChainStartRequest[] = [];
  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: async (req) => {
      chainStartCalls.push(req);
      return { handoff_id: 'handoff-3', conversation_id: 'conv-3' };
    },
    resolveAgent: () => undefined,
    defaults: DEFAULT_BOUNDS,
  });
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: 'Ship task 3.2',
    kind: 'orchestrate',
    eligibility: { allow_agents: [MAESTRO_AGENT.name] },
    created_by_kind: 'human',
    created_by_id: 'cli',
  });

  await waitFor(() => {
    const terminated = db
      .query<{ payload_json: string | null }, [string]>(
        `SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_terminated' ORDER BY id DESC LIMIT 1`,
      )
      .get(task_id);
    expect(terminated).toBeTruthy();
  });

  expect(sessions.get(task_id)).toBeNull();
  expect(chainStartCalls).toHaveLength(0);

  const terminated = db
    .query<{ payload_json: string | null }, [string]>(
      `SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_terminated' ORDER BY id DESC LIMIT 1`,
    )
    .get(task_id);
  const payload = JSON.parse(terminated?.payload_json ?? '{}') as { reason?: string; error?: string; agent_name?: string };
  expect(payload.reason).toBe('failed');
  expect(payload.error).toBe('unknown_agent');
  expect(payload.agent_name).toBe(MAESTRO_AGENT.name);

  reactor.stop();
  db.close();
});

test('non-orchestrate task is ignored', async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
  });

  const chainStartCalls: ChainStartRequest[] = [];
  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: async (req) => {
      chainStartCalls.push(req);
      return { handoff_id: 'handoff-4', conversation_id: 'conv-4' };
    },
    resolveAgent: (name) => (name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined),
    defaults: DEFAULT_BOUNDS,
  });
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: 'regular work item',
    kind: 'work',
    created_by_kind: 'human',
    created_by_id: 'cli',
  });

  await Bun.sleep(100);

  expect(sessions.get(task_id)).toBeNull();
  expect(chainStartCalls).toHaveLength(0);

  const spawnedCount = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'orchestrate_spawned'`,
    )
    .get(task_id);
  expect(spawnedCount?.n).toBe(0);

  reactor.stop();
  db.close();
});
