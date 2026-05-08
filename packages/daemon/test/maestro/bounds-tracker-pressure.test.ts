import { beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  buildServices,
  loadSqliteVec,
  migrate,
  MaestroSessionWriter,
  type Services,
} from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { createBoundsCallbacks } from '../../src/maestro/bounds-callbacks.js';
import { createBoundsTracker } from '../../src/maestro/bounds-tracker.js';

if (process.platform === 'darwin') {
  try {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  } catch {}
}

type AgentConfig = {
  name: string;
  pricing_mode?: 'api' | 'subscription';
  subscription_provider?: string;
};

type ProviderQuotaWithPressureCaps = {
  provider: string;
  pressure_caps?: Record<string, number>;
};

function makeServices(opts: {
  agents: AgentConfig[];
  providerQuotas: ProviderQuotaWithPressureCaps[];
}): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: '/tmp/penumbra-bounds-tracker-pressure-test',
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    providerQuotas: opts.providerQuotas as any,
    worktreeRootDir: '/tmp/penumbra-bounds-tracker-pressure-test/worktrees',
    mainRepoDir: '/tmp/penumbra-bounds-tracker-pressure-test/repo',
  });
  (services as Services & { agentchatConfig?: any }).agentchatConfig = {
    agents: opts.agents,
    default_roles: {},
    providers: opts.providerQuotas,
  };
  services.providerQuotas = opts.providerQuotas as any;
  services.watchdog = {
    recordHeartbeat: () => {},
    hasActiveWorker: () => true,
    tick: async () => {},
  };
  return services;
}

function seedTask(db: Database, taskId: string): void {
  db.query<unknown, [
    string,
    number,
    number,
    string,
    string,
    string | null,
    string,
    string,
    string,
    string | null,
    string | null,
    string,
    string | null,
    number,
    number | null,
    number | null,
    number | null,
    string | null,
    string,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
  ]>(
    `INSERT INTO tasks (
      id, created_at, updated_at, created_by_kind, created_by_id,
      parent_task_id, kind, priority, prompt, acceptance_criteria,
      expected_artifacts, eligibility, review_eligibility, requires_review,
      bounds_wall_clock_ms, bounds_cost_cents, bounds_max_sub_dispatches,
      bounds_started_at, status, result_summary, result_artifacts,
      failure_reason, chain_id, origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    1,
    1,
    'workflow',
    'test-suite',
    0,
    'orchestrate',
    'normal',
    'coordinate the run',
    null,
    null,
    '{}',
    null,
    0,
    null,
    null,
    null,
    null,
    'pending',
    null,
    null,
    null,
    null,
    null,
  );
}

function startSession(
  sessions: MaestroSessionWriter,
  args: {
    taskId: string;
    chainHandoffId: string;
    wallClockBudgetMs: number;
  },
): void {
  sessions.start({
    task_id: args.taskId,
    chain_handoff_id: args.chainHandoffId,
    agent_id: 'maestro',
    wall_clock_budget_ms: args.wallClockBudgetMs,
    cost_budget_cents: 100,
    sub_dispatch_budget: 10,
  });
}

function seedPressureSnapshot(services: Services, input: {
  event_id: string;
  provider: string;
  window_label: string;
  used_pct: number;
  observed_at: string;
}): void {
  services.t0Writer.write({
    event_id: input.event_id,
    ts: input.observed_at,
    ingest_ts: input.observed_at,
    source: 'agentchat',
    source_detail: 'pressure-cap-test',
    project_id: null,
    user_id: 'local-user',
    machine_id: services.machineId.get(),
    session_id: null,
    event_type: 'rate-limit-snapshot',
    lane: 'cli-subscription',
    provider: input.provider,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: {
      window_label: input.window_label,
      used_pct: input.used_pct,
      resets_at: null,
      source_kind: 'statusline',
    },
    payload_summary: null,
    origin: null,
  });
}

function seedSnapshots(services: Services, snapshots: Array<Parameters<typeof seedPressureSnapshot>[1]>): void {
  for (const snapshot of snapshots) {
    seedPressureSnapshot(services, snapshot);
  }
  services.subscriptionPressureCache.refresh();
}

function makeTracker(
  services: Services,
  sessions: MaestroSessionWriter,
  now: () => number,
): { tracker: ReturnType<typeof createBoundsTracker>; hardKills: Array<{ axis: string }> } {
  const hardKills: Array<{ axis: string }> = [];
  const callbacks = createBoundsCallbacks({
    db: services.db,
    services,
    taskWriter: {
      fail: () => {},
    },
    sessions: {
      terminate: (taskId, reason) => {
        sessions.terminate(taskId, reason);
      },
    },
    injector: {
      inject: async () => {},
    },
    bus: {
      publish: () => {},
    },
    chainCancel: async () => {},
    now,
  });
  return {
    hardKills,
    tracker: createBoundsTracker({
      db: services.db,
      sessions,
      now,
      onSoftWarn: () => {},
      onHardKill: (session, axis) => {
        hardKills.push({ axis });
        callbacks.onHardKill(session, axis);
      },
      evaluatePressure: callbacks.evaluatePressure,
    }),
  };
}

test('subscription maestro at 96% on seven_day trips pressure_capped:over_threshold', () => {
  let nowMs = 0;
  const freshObservedAt = new Date(Date.now() - 60_000).toISOString();
  const services = makeServices({
    agents: [{ name: 'maestro', pricing_mode: 'subscription', subscription_provider: 'anthropic' }],
    providerQuotas: [{ provider: 'anthropic', pressure_caps: { seven_day: 95 } }],
  });
  const sessions = new MaestroSessionWriter({ db: services.db, now: () => nowMs });
  seedTask(services.db, 'task-1');
  startSession(sessions, { taskId: 'task-1', chainHandoffId: 'h-root-1', wallClockBudgetMs: 10_000 });
  seedSnapshots(services, [{
    event_id: 'snap-1',
    provider: 'anthropic',
    window_label: 'seven_day',
    used_pct: 96,
    observed_at: freshObservedAt,
  }]);

  nowMs = 10_001;
  const { tracker } = makeTracker(services, sessions, () => nowMs);
  tracker.tick();

  expect(sessions.get('task-1')?.termination_reason).toBe('pressure_capped:over_threshold');
});

test('subscription maestro under cap does not pressure-trip and still obeys wall-clock bounds', () => {
  let nowMs = 0;
  const freshObservedAt = new Date(Date.now() - 60_000).toISOString();
  const services = makeServices({
    agents: [{ name: 'maestro', pricing_mode: 'subscription', subscription_provider: 'anthropic' }],
    providerQuotas: [{ provider: 'anthropic', pressure_caps: { seven_day: 95 } }],
  });
  const sessions = new MaestroSessionWriter({ db: services.db, now: () => nowMs });
  seedTask(services.db, 'task-2');
  startSession(sessions, { taskId: 'task-2', chainHandoffId: 'h-root-2', wallClockBudgetMs: 10_000 });
  seedSnapshots(services, [{
    event_id: 'snap-2',
    provider: 'anthropic',
    window_label: 'seven_day',
    used_pct: 50,
    observed_at: freshObservedAt,
  }]);

  const { tracker } = makeTracker(services, sessions, () => nowMs);
  tracker.tick();
  expect(sessions.get('task-2')?.termination_reason).toBeNull();

  nowMs = 10_001;
  tracker.tick();
  expect(sessions.get('task-2')?.termination_reason).toBe('bounds_exceeded:wall_clock');
});

test('pricing_mode api skips pressure check and wall-clock still trips', () => {
  let nowMs = 0;
  const freshObservedAt = new Date(Date.now() - 60_000).toISOString();
  const services = makeServices({
    agents: [{ name: 'maestro', pricing_mode: 'api', subscription_provider: 'anthropic' }],
    providerQuotas: [{ provider: 'anthropic', pressure_caps: { seven_day: 95 } }],
  });
  const sessions = new MaestroSessionWriter({ db: services.db, now: () => nowMs });
  seedTask(services.db, 'task-3');
  startSession(sessions, { taskId: 'task-3', chainHandoffId: 'h-root-3', wallClockBudgetMs: 10_000 });
  seedSnapshots(services, [{
    event_id: 'snap-3',
    provider: 'anthropic',
    window_label: 'seven_day',
    used_pct: 96,
    observed_at: freshObservedAt,
  }]);

  nowMs = 10_001;
  const { tracker } = makeTracker(services, sessions, () => nowMs);
  tracker.tick();

  expect(sessions.get('task-3')?.termination_reason).toBe('bounds_exceeded:wall_clock');
});

test('stale_warm pressure trips terminate with pressure_capped:stale_warm', () => {
  let nowMs = 0;
  const staleObservedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const services = makeServices({
    agents: [{ name: 'maestro', pricing_mode: 'subscription', subscription_provider: 'anthropic' }],
    providerQuotas: [{ provider: 'anthropic', pressure_caps: { seven_day: 95 } }],
  });
  const sessions = new MaestroSessionWriter({ db: services.db, now: () => nowMs });
  seedTask(services.db, 'task-4');
  startSession(sessions, { taskId: 'task-4', chainHandoffId: 'h-root-4', wallClockBudgetMs: 10_000 });
  seedSnapshots(services, [{
    event_id: 'snap-4',
    provider: 'anthropic',
    window_label: 'seven_day',
    used_pct: 60,
    observed_at: staleObservedAt,
  }]);

  nowMs = 10_001;
  const { tracker } = makeTracker(services, sessions, () => nowMs);
  tracker.tick();

  expect(sessions.get('task-4')?.termination_reason).toBe('pressure_capped:stale_warm');
});

test('pressure trip writes t0 event with tracker_tick trigger', () => {
  let nowMs = 0;
  const freshObservedAt = new Date(Date.now() - 60_000).toISOString();
  const services = makeServices({
    agents: [{ name: 'maestro', pricing_mode: 'subscription', subscription_provider: 'anthropic' }],
    providerQuotas: [{ provider: 'anthropic', pressure_caps: { seven_day: 95 } }],
  });
  const sessions = new MaestroSessionWriter({ db: services.db, now: () => nowMs });
  seedTask(services.db, 'task-5');
  startSession(sessions, { taskId: 'task-5', chainHandoffId: 'h-root-5', wallClockBudgetMs: 10_000 });
  seedSnapshots(services, [{
    event_id: 'snap-5',
    provider: 'anthropic',
    window_label: 'seven_day',
    used_pct: 96,
    observed_at: freshObservedAt,
  }]);

  nowMs = 10_001;
  const { tracker } = makeTracker(services, sessions, () => nowMs);
  tracker.tick();

  const row = services.db.query<{ provider: string | null; payload_json: string }, []>(
    `SELECT provider, payload_json
     FROM t0_events
     WHERE event_type = 'subscription-pressure-cap-trip'
     ORDER BY ts DESC
     LIMIT 1`,
  ).get();

  expect(row?.provider).toBe('anthropic');
  expect(JSON.parse(row?.payload_json ?? '{}')).toMatchObject({
    state: 'refuse',
    reason: 'over_threshold',
    provider: 'anthropic',
    window_label: 'seven_day',
    used_pct: 96,
    cap_pct: 95,
    snapshot_state: 'fresh',
    subject: 'maestro',
    trigger: 'tracker_tick',
    agent_name: 'maestro',
    task_id: 'task-5',
  });
});

test('pressure trip preempts wall-clock termination', () => {
  let nowMs = 0;
  const freshObservedAt = new Date(Date.now() - 60_000).toISOString();
  const services = makeServices({
    agents: [{ name: 'maestro', pricing_mode: 'subscription', subscription_provider: 'anthropic' }],
    providerQuotas: [{ provider: 'anthropic', pressure_caps: { seven_day: 95 } }],
  });
  const sessions = new MaestroSessionWriter({ db: services.db, now: () => nowMs });
  seedTask(services.db, 'task-6');
  startSession(sessions, { taskId: 'task-6', chainHandoffId: 'h-root-6', wallClockBudgetMs: 10_000 });
  seedSnapshots(services, [{
    event_id: 'snap-6',
    provider: 'anthropic',
    window_label: 'seven_day',
    used_pct: 96,
    observed_at: freshObservedAt,
  }]);

  nowMs = 10_001;
  const { tracker } = makeTracker(services, sessions, () => nowMs);
  tracker.tick();

  expect(sessions.get('task-6')?.termination_reason).toBe('pressure_capped:over_threshold');
});

test('pressure trip fires every tick even when wall-clock/cost/sub_dispatches are healthy', () => {
  let nowMs = 0;
  const freshObservedAt = new Date(Date.now() - 60_000).toISOString();
  const services = makeServices({
    agents: [{ name: 'maestro', pricing_mode: 'subscription', subscription_provider: 'anthropic' }],
    providerQuotas: [{ provider: 'anthropic', pressure_caps: { seven_day: 95 } }],
  });
  const sessions = new MaestroSessionWriter({ db: services.db, now: () => nowMs });
  seedTask(services.db, 'task-7');
  // generous wall-clock budget so it cannot trip on its own
  startSession(sessions, { taskId: 'task-7', chainHandoffId: 'h-root-7', wallClockBudgetMs: 1_000_000 });
  seedSnapshots(services, [{
    event_id: 'snap-7',
    provider: 'anthropic',
    window_label: 'seven_day',
    used_pct: 96,
    observed_at: freshObservedAt,
  }]);

  // nowMs stays at 0 (well within wall-clock budget) — pressure must trip on its own
  nowMs = 50;
  const { tracker, hardKills } = makeTracker(services, sessions, () => nowMs);
  tracker.tick();

  expect(sessions.get('task-7')?.termination_reason).toBe('pressure_capped:over_threshold');
  expect(hardKills).toEqual([{ axis: 'subscription_pressure' }]);
});
