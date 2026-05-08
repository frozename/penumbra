import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { chainStartInternal } from '../../src/routes/chains.js';

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

const NOW = new Date('2026-05-08T01:00:00Z');

function tempServices(opts: {
  agents: AgentConfig[];
  providerQuotas?: ProviderQuotaWithPressureCaps[];
  agentRegistry?: string[];
}): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: '/tmp/chain-start-pressure-cap-test',
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date(NOW),
    uuid: () => `id-${++n}`,
    agentRegistry: opts.agentRegistry ?? opts.agents.map((agent) => agent.name),
    worktreeRootDir: '/tmp/penumbra-chain-start-pressure-cap-worktrees',
    mainRepoDir: '/tmp/penumbra-chain-start-pressure-cap-main',
    providerQuotas: opts.providerQuotas as any,
  });
  services.watchdog = {
    recordHeartbeat: () => {},
    hasActiveWorker: () => true,
    tick: async () => {},
  };
  attachRuntimeConfig(services, opts.agents, opts.providerQuotas ?? []);
  return services;
}

function attachRuntimeConfig(
  services: Services,
  agents: AgentConfig[],
  providerQuotas: ProviderQuotaWithPressureCaps[],
): void {
  (services as Services & { agentchatConfig?: any }).agentchatConfig = {
    agents,
    default_roles: {},
    providers: providerQuotas,
  };
  services.providerQuotas = providerQuotas as any;
}

function seedPressureSnapshot(services: Services, input: {
  event_id: string;
  provider: string;
  window_label: string;
  used_pct: number;
  observed_at: string;
  source_kind?: string;
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
      source_kind: input.source_kind ?? 'statusline',
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

function seedParentHandoff(services: Services, input: { handoff_id: string; to: string }): void {
  services.handoffWriter.createApproved({
    handoff_id: input.handoff_id,
    ts: NOW.toISOString(),
    project_id: null,
    conversation_id: `conv-${input.handoff_id}`,
    from: 'user',
    to: input.to,
    to_role: null,
    message: 'parent dispatch',
    triggered_by_event_id: null,
    resolved_by: 'test',
    resolved_at: NOW.toISOString(),
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
    branch_base: null,
  });
}

function startChain(
  services: Services,
  input: {
    initial_agent: string;
    message?: string;
    parent_handoff_id?: string;
  },
): Response {
  return chainStartInternal({
    initial_agent: input.initial_agent,
    message: input.message ?? 'spawn child',
    parent_handoff_id: input.parent_handoff_id,
  }, services);
}

function pressureCapBody(response: Response): Promise<{
  error: {
    code: string;
    subject: 'maestro' | 'sub_agent';
    agent_name: string;
    provider: string;
    window_label: string;
    used_pct: number;
    cap_pct: number;
    snapshot_state: 'fresh' | 'stale_warm';
    snapshot_age_seconds: number;
  };
}> {
  return response.json() as Promise<{
    error: {
      code: string;
      subject: 'maestro' | 'sub_agent';
      agent_name: string;
      provider: string;
      window_label: string;
      used_pct: number;
      cap_pct: number;
      snapshot_state: 'fresh' | 'stale_warm';
      snapshot_age_seconds: number;
    };
  }>;
}

test('no parent_handoff_id skips the pressure gate even with high snapshots', async () => {
  const services = tempServices({
    agents: [
      { name: 'planner', pricing_mode: 'subscription', subscription_provider: 'openai' },
    ],
    providerQuotas: [
      { provider: 'anthropic', pressure_caps: { five_hour: 95 } },
      { provider: 'openai', pressure_caps: { five_hour: 95 } },
    ],
  });
  seedSnapshots(services, [{
    event_id: 'snap-1',
    provider: 'openai',
    window_label: 'five_hour',
    used_pct: 99,
    observed_at: '2026-05-08T00:50:00Z',
  }]);

  const res = startChain(services, { initial_agent: 'planner', message: 'spawn child' });

  expect(res.status).toBe(200);
});

test('maestro trips on over_threshold and returns 400', async () => {
  const services = tempServices({
    agents: [
      { name: 'maestro', pricing_mode: 'subscription', subscription_provider: 'anthropic' },
      { name: 'planner', pricing_mode: 'subscription', subscription_provider: 'openai' },
    ],
    providerQuotas: [
      { provider: 'anthropic', pressure_caps: { five_hour: 95 } },
      { provider: 'openai', pressure_caps: { five_hour: 95 } },
    ],
  });
  seedParentHandoff(services, { handoff_id: 'h-parent-1', to: 'maestro' });
  seedSnapshots(services, [{
    event_id: 'snap-2',
    provider: 'anthropic',
    window_label: 'five_hour',
    used_pct: 96,
    observed_at: '2026-05-08T00:50:00Z',
  }]);

  const res = startChain(services, {
    initial_agent: 'planner',
    parent_handoff_id: 'h-parent-1',
  });

  expect(res.status).toBe(400);
  expect(await pressureCapBody(res)).toEqual({
    error: {
      code: 'subscription_pressure_capped',
      subject: 'maestro',
      agent_name: 'maestro',
      provider: 'anthropic',
      window_label: 'five_hour',
      used_pct: 96,
      cap_pct: 95,
      snapshot_state: 'fresh',
      snapshot_age_seconds: 600,
    },
  });
});

test('sub-agent trips and returns 400', async () => {
  const services = tempServices({
    agents: [
      { name: 'maestro', pricing_mode: 'subscription', subscription_provider: 'anthropic' },
      { name: 'planner', pricing_mode: 'subscription', subscription_provider: 'openai' },
    ],
    providerQuotas: [
      { provider: 'anthropic', pressure_caps: { five_hour: 95 } },
      { provider: 'openai', pressure_caps: { five_hour: 95 } },
    ],
  });
  seedParentHandoff(services, { handoff_id: 'h-parent-2', to: 'maestro' });
  seedSnapshots(services, [
    {
      event_id: 'snap-3',
      provider: 'anthropic',
      window_label: 'five_hour',
      used_pct: 90,
      observed_at: '2026-05-08T00:50:00Z',
    },
    {
      event_id: 'snap-4',
      provider: 'openai',
      window_label: 'five_hour',
      used_pct: 96,
      observed_at: '2026-05-08T00:50:00Z',
    },
  ]);

  const res = startChain(services, {
    initial_agent: 'planner',
    parent_handoff_id: 'h-parent-2',
  });

  expect(res.status).toBe(400);
  expect(await pressureCapBody(res)).toEqual({
    error: {
      code: 'subscription_pressure_capped',
      subject: 'sub_agent',
      agent_name: 'planner',
      provider: 'openai',
      window_label: 'five_hour',
      used_pct: 96,
      cap_pct: 95,
      snapshot_state: 'fresh',
      snapshot_age_seconds: 600,
    },
  });
});

test('both gates pass and chain_start proceeds', () => {
  const services = tempServices({
    agents: [
      { name: 'maestro', pricing_mode: 'subscription', subscription_provider: 'anthropic' },
      { name: 'planner', pricing_mode: 'subscription', subscription_provider: 'openai' },
    ],
    providerQuotas: [
      { provider: 'anthropic', pressure_caps: { five_hour: 95 } },
      { provider: 'openai', pressure_caps: { five_hour: 95 } },
    ],
  });
  seedParentHandoff(services, { handoff_id: 'h-parent-3', to: 'maestro' });
  seedSnapshots(services, [
    {
      event_id: 'snap-5',
      provider: 'anthropic',
      window_label: 'five_hour',
      used_pct: 70,
      observed_at: '2026-05-08T00:50:00Z',
    },
    {
      event_id: 'snap-6',
      provider: 'openai',
      window_label: 'five_hour',
      used_pct: 80,
      observed_at: '2026-05-08T00:50:00Z',
    },
  ]);

  const res = startChain(services, {
    initial_agent: 'planner',
    parent_handoff_id: 'h-parent-3',
  });

  expect(res.status).toBe(200);
});

test('stale_warm snapshots return 400', async () => {
  const services = tempServices({
    agents: [
      { name: 'maestro', pricing_mode: 'subscription', subscription_provider: 'anthropic' },
      { name: 'planner', pricing_mode: 'subscription', subscription_provider: 'openai' },
    ],
    providerQuotas: [
      { provider: 'anthropic', pressure_caps: { five_hour: 95 } },
      { provider: 'openai', pressure_caps: { five_hour: 95 } },
    ],
  });
  seedParentHandoff(services, { handoff_id: 'h-parent-4', to: 'maestro' });
  seedSnapshots(services, [{
    event_id: 'snap-7',
    provider: 'anthropic',
    window_label: 'five_hour',
    used_pct: 60,
    observed_at: '2026-05-08T00:20:00Z',
  }]);

  const res = startChain(services, {
    initial_agent: 'planner',
    parent_handoff_id: 'h-parent-4',
  });

  expect(res.status).toBe(400);
  expect(await pressureCapBody(res)).toEqual({
    error: {
      code: 'subscription_pressure_capped',
      subject: 'maestro',
      agent_name: 'maestro',
      provider: 'anthropic',
      window_label: 'five_hour',
      used_pct: 60,
      cap_pct: 95,
      snapshot_state: 'stale_warm',
      snapshot_age_seconds: 2400,
    },
  });
});

test('api maestro spawning subscription sub-agent only runs the sub-agent gate', () => {
  const services = tempServices({
    agents: [
      { name: 'maestro', pricing_mode: 'api', subscription_provider: 'anthropic' },
      { name: 'planner', pricing_mode: 'subscription', subscription_provider: 'openai' },
    ],
    providerQuotas: [
      { provider: 'anthropic', pressure_caps: { five_hour: 95 } },
      { provider: 'openai', pressure_caps: { five_hour: 95 } },
    ],
  });
  seedParentHandoff(services, { handoff_id: 'h-parent-5', to: 'maestro' });
  seedSnapshots(services, [
    {
      event_id: 'snap-8',
      provider: 'anthropic',
      window_label: 'five_hour',
      used_pct: 99,
      observed_at: '2026-05-08T00:50:00Z',
    },
    {
      event_id: 'snap-9',
      provider: 'openai',
      window_label: 'five_hour',
      used_pct: 80,
      observed_at: '2026-05-08T00:50:00Z',
    },
  ]);

  const res = startChain(services, {
    initial_agent: 'planner',
    parent_handoff_id: 'h-parent-5',
  });

  expect(res.status).toBe(200);
});

test('subscription maestro spawning api sub-agent only runs the maestro gate', () => {
  const services = tempServices({
    agents: [
      { name: 'maestro', pricing_mode: 'subscription', subscription_provider: 'anthropic' },
      { name: 'planner', pricing_mode: 'api', subscription_provider: 'openai' },
    ],
    providerQuotas: [
      { provider: 'anthropic', pressure_caps: { five_hour: 95 } },
      { provider: 'openai', pressure_caps: { five_hour: 95 } },
    ],
  });
  seedParentHandoff(services, { handoff_id: 'h-parent-6', to: 'maestro' });
  seedSnapshots(services, [
    {
      event_id: 'snap-10',
      provider: 'anthropic',
      window_label: 'five_hour',
      used_pct: 70,
      observed_at: '2026-05-08T00:50:00Z',
    },
    {
      event_id: 'snap-11',
      provider: 'openai',
      window_label: 'five_hour',
      used_pct: 99,
      observed_at: '2026-05-08T00:50:00Z',
    },
  ]);

  const res = startChain(services, {
    initial_agent: 'planner',
    parent_handoff_id: 'h-parent-6',
  });

  expect(res.status).toBe(200);
});

test('trip writes a subscription-pressure-cap-trip t0 event', async () => {
  const services = tempServices({
    agents: [
      { name: 'maestro', pricing_mode: 'subscription', subscription_provider: 'anthropic' },
      { name: 'planner', pricing_mode: 'subscription', subscription_provider: 'openai' },
    ],
    providerQuotas: [
      { provider: 'anthropic', pressure_caps: { five_hour: 95 } },
      { provider: 'openai', pressure_caps: { five_hour: 95 } },
    ],
  });
  seedParentHandoff(services, { handoff_id: 'h-parent-7', to: 'maestro' });
  seedSnapshots(services, [{
    event_id: 'snap-12',
    provider: 'anthropic',
    window_label: 'five_hour',
    used_pct: 96,
    observed_at: '2026-05-08T00:50:00Z',
  }]);

  const res = startChain(services, {
    initial_agent: 'planner',
    parent_handoff_id: 'h-parent-7',
  });

  expect(res.status).toBe(400);

  const row = services.db
    .query<{ event_type: string; provider: string | null; payload_json: string }, []>(
      `SELECT event_type, provider, payload_json
       FROM t0_events
       WHERE event_type = 'subscription-pressure-cap-trip'
       ORDER BY ts DESC
       LIMIT 1`,
    )
    .get();

  expect(row).toBeTruthy();
  expect(row?.provider).toBe('anthropic');
  expect(JSON.parse(row?.payload_json ?? '{}')).toMatchObject({
    state: 'refuse',
    reason: 'over_threshold',
    provider: 'anthropic',
    window_label: 'five_hour',
    used_pct: 96,
    cap_pct: 95,
    snapshot_state: 'fresh',
    snapshot_age_seconds: 600,
    subject: 'maestro',
    trigger: 'pre_dispatch',
    maestro_agent_name: 'maestro',
    sub_agent_name: 'planner',
  });
});
