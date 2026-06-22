import {
  AgentPerformanceWriter,
  type AgentTaskType,
  buildServices,
  loadSqliteVec,
  migrate,
  type ProviderQuota,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";

import { chainStartInternal } from "../../src/routes/chains.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // Optional Homebrew SQLite is unavailable in some CI images.
  }
}

type AgentchatConfig = NonNullable<Services["agentchatConfig"]>;
type AgentchatAgent = NonNullable<AgentchatConfig["agents"]>[number];

type T0Event = Parameters<Services["t0Writer"]["write"]>[0];

type PressureCapErrorBody = {
  error: {
    code: string;
    subject: "maestro" | "sub_agent";
    agent_name: string;
    provider: string;
    window_label: string;
    used_pct: number;
    cap_pct: number;
    snapshot_state: "fresh" | "stale_warm";
    snapshot_age_seconds: number;
    resets_at: number | null;
    earliest_resets_at: number | null;
  };
};

type ChainStartOkBody = { handoff_id: string };

type ClassifierRetryBody = { error: { code: string } };

type FallbackEventRow = { payload_json: string };

// strict-mode env can leak from a live maestro shell; clear it here so test fixtures stay deterministic
beforeAll(() => {
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
});

type AgentConfig = {
  name: string;
  pricing_mode?: "api" | "subscription";
  subscription_provider?: string;
};

type ProviderQuotaWithPressureCaps = ProviderQuota;

function toAgentchatAgent(agent: AgentConfig): AgentchatAgent {
  return { ...agent, roles: [] };
}

const NOW = new Date("2026-05-08T01:00:00Z");

function tempServices(opts: {
  agents: AgentConfig[];
  providerQuotas?: ProviderQuotaWithPressureCaps[];
  agentRegistry?: string[];
}): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/chain-start-pressure-cap-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date(NOW),
    uuid: () => `id-${String(++n)}`,
    agentRegistry: opts.agentRegistry ?? opts.agents.map((agent) => agent.name),
    worktreeRootDir: "/tmp/penumbra-chain-start-pressure-cap-worktrees",
    mainRepoDir: "/tmp/penumbra-chain-start-pressure-cap-main",
    providerQuotas: opts.providerQuotas,
  });
  services.watchdog = {
    recordHeartbeat: (): void => {
      /* no-op */
    },
    hasActiveWorker: (): boolean => true,
    getStaleWorkers: (): string[] => [],
    getStaleHeartbeatAges: (): { worker_id: string; last_seen_age_ms: number }[] => [],
    tick: (): Promise<void> => Promise.resolve(),
  };
  attachRuntimeConfig(services, opts.agents, opts.providerQuotas ?? []);
  return services;
}

function attachRuntimeConfig(
  services: Services,
  agents: AgentConfig[],
  providerQuotas: ProviderQuotaWithPressureCaps[],
): void {
  services.agentchatConfig = {
    agents: agents.map(toAgentchatAgent),
  };
  services.providerQuotas = providerQuotas;
}

function seedPressureSnapshot(
  services: Services,
  input: {
    event_id: string;
    provider: string;
    window_label: string;
    used_pct: number;
    resets_at?: number | null;
    observed_at: string;
    source_kind?: string;
  },
): void {
  services.t0Writer.write({
    event_id: input.event_id,
    ts: input.observed_at,
    ingest_ts: input.observed_at,
    source: "agentchat",
    source_detail: "pressure-cap-test",
    project_id: null,
    user_id: "local-user",
    machine_id: services.machineId.get(),
    session_id: null,
    event_type: "rate-limit-snapshot",
    lane: "cli-subscription",
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
      resets_at: input.resets_at ?? null,
      source_kind: input.source_kind ?? "statusline",
    },
    payload_summary: null,
    origin: null,
  });
}

function seedSnapshots(
  services: Services,
  snapshots: Parameters<typeof seedPressureSnapshot>[1][],
): void {
  for (const snapshot of snapshots) {
    seedPressureSnapshot(services, snapshot);
  }
  services.subscriptionPressureCache.refresh();
}

function seedPerformance(
  services: Services,
  input: {
    performance_id: string;
    handoff_id: string;
    agent_name: string;
    task_type: AgentTaskType;
    outcome: "merged" | "failed";
    latency_ms?: number | null;
  },
): void {
  new AgentPerformanceWriter(services.db).upsert({
    performance_id: input.performance_id,
    ts: "2026-05-07T00:00:00.000Z",
    handoff_id: input.handoff_id,
    conversation_id: "conv-pressure-fallback",
    project_id: null,
    agent_name: input.agent_name,
    task_type: input.task_type,
    outcome: input.outcome,
    rounds: 1,
    smoke_pass: input.outcome === "merged" ? "y" : "n",
    reviewer_findings: null,
    maestro_score: 5,
    cost_usd: null,
    tokens_used: null,
    latency_ms: input.latency_ms ?? null,
    source: "manual_seed",
    notes: null,
    metadata_json: "{}",
  });
}

function seedParentHandoff(services: Services, input: { handoff_id: string; to: string }): void {
  services.handoffWriter.createApproved({
    handoff_id: input.handoff_id,
    ts: NOW.toISOString(),
    project_id: null,
    conversation_id: `conv-${input.handoff_id}`,
    from: "user",
    to: input.to,
    to_role: null,
    message: "parent dispatch",
    triggered_by_event_id: null,
    resolved_by: "test",
    resolved_at: NOW.toISOString(),
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
    branch_base: null,
  });
}

function recordClassifierDecline(services: Services, handoffId: string): void {
  services.dispatchEventLog.record({
    handoff_id: handoffId,
    worker_id: "worker-1",
    source: "worker",
    kind: "dispatch.end",
    ts: NOW.toISOString(),
    meta: {
      status: "error",
      classifier_declined: true,
      decline_reason: "provider_safety_refusal",
    },
  });
}

function startChain(
  services: Services,
  input: {
    initial_agent: string;
    message?: string;
    parent_handoff_id?: string;
    task_type?: AgentTaskType;
  },
): Promise<Response> {
  return chainStartInternal(
    {
      initial_agent: input.initial_agent,
      message: input.message ?? "spawn child",
      parent_handoff_id: input.parent_handoff_id,
      task_type: input.task_type,
    },
    services,
  );
}

function fallbackEvents(services: Services): FallbackEventRow[] {
  return services.db
    .query<FallbackEventRow, []>(
      `SELECT payload_json
     FROM t0_events
     WHERE event_type = 'subscription-pressure-fallback'
     ORDER BY rowid ASC`,
    )
    .all();
}

function parseFallbackPayloads(services: Services): unknown[] {
  return fallbackEvents(services).map((event): unknown => JSON.parse(event.payload_json));
}

function pressureCapBody(response: Response): Promise<PressureCapErrorBody> {
  return response.json() as Promise<PressureCapErrorBody>;
}

async function readChainStartBody(response: Response): Promise<ChainStartOkBody> {
  return (await response.json()) as ChainStartOkBody;
}

async function readClassifierRetryError(response: Response): Promise<ClassifierRetryBody> {
  return (await response.json()) as ClassifierRetryBody;
}

test("no parent_handoff_id skips the pressure gate even with high snapshots", async () => {
  const services = tempServices({
    agents: [{ name: "planner", pricing_mode: "subscription", subscription_provider: "openai" }],
    providerQuotas: [
      { provider: "anthropic", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
      { provider: "openai", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
    ],
  });
  seedSnapshots(services, [
    {
      event_id: "snap-1",
      provider: "openai",
      window_label: "five_hour",
      used_pct: 99,
      observed_at: "2026-05-08T00:50:00Z",
    },
  ]);

  const res = await startChain(services, { initial_agent: "planner", message: "spawn child" });

  expect(res.status).toBe(200);
});

test("maestro trips on over_threshold and returns 400", async () => {
  const services = tempServices({
    agents: [
      { name: "maestro", pricing_mode: "subscription", subscription_provider: "anthropic" },
      { name: "planner", pricing_mode: "subscription", subscription_provider: "openai" },
    ],
    providerQuotas: [
      { provider: "anthropic", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
      { provider: "openai", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
    ],
  });
  seedParentHandoff(services, { handoff_id: "h-parent-1", to: "maestro" });
  seedSnapshots(services, [
    {
      event_id: "snap-2",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 96,
      observed_at: "2026-05-08T00:50:00Z",
    },
  ]);

  const res = await startChain(services, {
    initial_agent: "planner",
    parent_handoff_id: "h-parent-1",
  });

  expect(res.status).toBe(400);
  expect(await pressureCapBody(res)).toEqual({
    error: {
      code: "subscription_pressure_capped",
      subject: "maestro",
      agent_name: "maestro",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 96,
      cap_pct: 95,
      snapshot_state: "fresh",
      snapshot_age_seconds: 600,
      resets_at: null,
      earliest_resets_at: null,
    },
  });
  expect(fallbackEvents(services)).toHaveLength(0);
});

test("maestro warn band does not block dispatch or emit a trip event", async () => {
  const services = tempServices({
    agents: [
      { name: "maestro", pricing_mode: "subscription", subscription_provider: "anthropic" },
      { name: "planner", pricing_mode: "subscription", subscription_provider: "openai" },
    ],
    providerQuotas: [
      { provider: "anthropic", pressure_caps: { five_hour: { warn: 80, refuse: 95 } } },
      { provider: "openai", pressure_caps: { five_hour: { warn: 80, refuse: 95 } } },
    ],
  });
  seedParentHandoff(services, { handoff_id: "h-parent-warn", to: "maestro" });
  seedSnapshots(services, [
    {
      event_id: "snap-warn",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 85,
      observed_at: "2026-05-08T00:50:00Z",
    },
  ]);

  const tripEvents: T0Event[] = [];
  const originalWrite: Services["t0Writer"]["write"] = services.t0Writer.write.bind(
    services.t0Writer,
  );
  services.t0Writer.write = (event: T0Event): ReturnType<Services["t0Writer"]["write"]> => {
    if (event.event_type === "subscription-pressure-cap-trip") tripEvents.push(event);
    return originalWrite(event);
  };

  const res = await startChain(services, {
    initial_agent: "planner",
    parent_handoff_id: "h-parent-warn",
  });

  expect(res.status).toBe(200);
  expect(tripEvents).toHaveLength(0);
});

test("sub-agent trips and returns 400", async () => {
  const services = tempServices({
    agents: [
      { name: "maestro", pricing_mode: "subscription", subscription_provider: "anthropic" },
      { name: "planner", pricing_mode: "subscription", subscription_provider: "openai" },
    ],
    providerQuotas: [
      { provider: "anthropic", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
      { provider: "openai", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
    ],
  });
  seedParentHandoff(services, { handoff_id: "h-parent-2", to: "maestro" });
  seedSnapshots(services, [
    {
      event_id: "snap-3",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 90,
      observed_at: "2026-05-08T00:50:00Z",
    },
    {
      event_id: "snap-4",
      provider: "openai",
      window_label: "five_hour",
      used_pct: 96,
      observed_at: "2026-05-08T00:50:00Z",
    },
  ]);

  const res = await startChain(services, {
    initial_agent: "planner",
    parent_handoff_id: "h-parent-2",
  });

  expect(res.status).toBe(400);
  expect(await pressureCapBody(res)).toEqual({
    error: {
      code: "subscription_pressure_capped",
      subject: "sub_agent",
      agent_name: "planner",
      provider: "openai",
      window_label: "five_hour",
      used_pct: 96,
      cap_pct: 95,
      snapshot_state: "fresh",
      snapshot_age_seconds: 600,
      resets_at: null,
      earliest_resets_at: null,
    },
  });
  expect(fallbackEvents(services)).toHaveLength(0);
});

test("sub-agent refuse + no recommendations returns 400 and emits exhausted fallback summary", async () => {
  const services = tempServices({
    agents: [
      { name: "maestro", pricing_mode: "subscription", subscription_provider: "anthropic" },
      { name: "planner", pricing_mode: "subscription", subscription_provider: "openai" },
    ],
    providerQuotas: [
      { provider: "anthropic", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
      { provider: "openai", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
    ],
  });
  seedParentHandoff(services, { handoff_id: "h-parent-fallback-none", to: "maestro" });
  seedSnapshots(services, [
    {
      event_id: "snap-fallback-none-maestro",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 70,
      observed_at: "2026-05-08T00:50:00Z",
    },
    {
      event_id: "snap-fallback-none-sub",
      provider: "openai",
      window_label: "five_hour",
      used_pct: 96,
      observed_at: "2026-05-08T00:50:00Z",
    },
  ]);

  const res = await startChain(services, {
    initial_agent: "planner",
    parent_handoff_id: "h-parent-fallback-none",
    task_type: "implement_substantial",
  });

  expect(res.status).toBe(400);
  expect(await pressureCapBody(res)).toEqual({
    error: {
      code: "subscription_pressure_capped",
      subject: "sub_agent",
      agent_name: "planner",
      provider: "openai",
      window_label: "five_hour",
      used_pct: 96,
      cap_pct: 95,
      snapshot_state: "fresh",
      snapshot_age_seconds: 600,
      resets_at: null,
      earliest_resets_at: null,
    },
  });

  const events = parseFallbackPayloads(services);
  expect(events).toEqual([
    expect.objectContaining({
      parent_handoff_id: "h-parent-fallback-none",
      task_type: "implement_substantial",
      original_agent: "planner",
      candidate_agent: null,
      candidate_state: "exhausted",
      attempt_index: 0,
      total_attempts: 0,
      exhausted_reason: "no_recommendations",
    }),
  ]);
});

test("sub-agent refuse falls back to top recommendation when pressure passes", async () => {
  const services = tempServices({
    agents: [
      { name: "maestro", pricing_mode: "subscription", subscription_provider: "anthropic" },
      { name: "planner", pricing_mode: "subscription", subscription_provider: "openai" },
      { name: "codex", pricing_mode: "subscription", subscription_provider: "google" },
    ],
    providerQuotas: [
      { provider: "anthropic", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
      { provider: "openai", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
      { provider: "google", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
    ],
  });
  seedParentHandoff(services, { handoff_id: "h-parent-fallback-top1", to: "maestro" });
  seedSnapshots(services, [
    {
      event_id: "snap-fallback-top1-maestro",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 70,
      observed_at: "2026-05-08T00:50:00Z",
    },
    {
      event_id: "snap-fallback-top1-sub",
      provider: "openai",
      window_label: "five_hour",
      used_pct: 96,
      observed_at: "2026-05-08T00:50:00Z",
    },
    {
      event_id: "snap-fallback-top1-candidate",
      provider: "google",
      window_label: "five_hour",
      used_pct: 40,
      observed_at: "2026-05-08T00:50:00Z",
    },
  ]);
  seedPerformance(services, {
    performance_id: "perf-top1",
    handoff_id: "handoff-top1",
    agent_name: "codex",
    task_type: "implement_substantial",
    outcome: "merged",
    latency_ms: 1200,
  });

  const res = await startChain(services, {
    initial_agent: "planner",
    parent_handoff_id: "h-parent-fallback-top1",
    task_type: "implement_substantial",
  });

  expect(res.status).toBe(200);
  const body = (await res.json()) as { handoff_id: string };
  const handoff = services.db
    .query<{ to_agent: string }, [string]>(`SELECT to_agent FROM handoffs WHERE handoff_id=?`)
    .get(body.handoff_id);
  expect(handoff?.to_agent).toBe("codex");

  const events = parseFallbackPayloads(services);
  expect(events).toEqual([
    expect.objectContaining({
      original_agent: "planner",
      candidate_agent: "codex",
      candidate_state: "selected",
      attempt_index: 0,
      ranking: expect.objectContaining({ samples: 1 }) as unknown,
    }),
    expect.objectContaining({
      original_agent: "planner",
      candidate_agent: "codex",
      candidate_state: "selected",
      attempt_index: 1,
      total_attempts: 1,
      exhausted_reason: null,
    }),
  ]);
});

test("classifier-declined parent falls back exactly once to the top recommendation", async () => {
  const services = tempServices({
    agents: [
      { name: "maestro", pricing_mode: "subscription", subscription_provider: "anthropic" },
      { name: "planner", pricing_mode: "subscription", subscription_provider: "openai" },
      { name: "codex", pricing_mode: "subscription", subscription_provider: "google" },
    ],
    providerQuotas: [],
  });
  seedParentHandoff(services, { handoff_id: "h-parent-classifier-decline", to: "maestro" });
  recordClassifierDecline(services, "h-parent-classifier-decline");
  seedPerformance(services, {
    performance_id: "perf-classifier-fallback",
    handoff_id: "handoff-classifier-fallback",
    agent_name: "codex",
    task_type: "implement_substantial",
    outcome: "merged",
    latency_ms: 1200,
  });

  const res = await startChain(services, {
    initial_agent: "planner",
    parent_handoff_id: "h-parent-classifier-decline",
    task_type: "implement_substantial",
  });

  expect(res.status).toBe(200);
  const body = (await res.json()) as { handoff_id: string };
  const handoff = services.db
    .query<{ to_agent: string }, [string]>(`SELECT to_agent FROM handoffs WHERE handoff_id=?`)
    .get(body.handoff_id);
  expect(handoff?.to_agent).toBe("codex");

  recordClassifierDecline(services, body.handoff_id);
  const retryRes = await startChain(services, {
    initial_agent: "planner",
    parent_handoff_id: body.handoff_id,
    task_type: "implement_substantial",
  });
  expect(retryRes.status).toBe(409);
  expect((await readClassifierRetryError(retryRes)).error.code).toBe(
    "classifier_decline_retry_exhausted",
  );
});

test("sub-agent refuse skips refused top-1 and selects top-2 fallback", async () => {
  const services = tempServices({
    agents: [
      { name: "maestro", pricing_mode: "subscription", subscription_provider: "anthropic" },
      { name: "planner", pricing_mode: "subscription", subscription_provider: "openai" },
      { name: "codex", pricing_mode: "subscription", subscription_provider: "groq" },
      { name: "gemini", pricing_mode: "subscription", subscription_provider: "google" },
    ],
    providerQuotas: [
      { provider: "anthropic", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
      { provider: "openai", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
      { provider: "groq", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
      { provider: "google", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
    ],
  });
  seedParentHandoff(services, { handoff_id: "h-parent-fallback-top2", to: "maestro" });
  seedSnapshots(services, [
    {
      event_id: "snap-fallback-top2-maestro",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 70,
      observed_at: "2026-05-08T00:50:00Z",
    },
    {
      event_id: "snap-fallback-top2-sub",
      provider: "openai",
      window_label: "five_hour",
      used_pct: 96,
      observed_at: "2026-05-08T00:50:00Z",
    },
    {
      event_id: "snap-fallback-top2-top1",
      provider: "groq",
      window_label: "five_hour",
      used_pct: 96,
      observed_at: "2026-05-08T00:50:00Z",
    },
    {
      event_id: "snap-fallback-top2-top2",
      provider: "google",
      window_label: "five_hour",
      used_pct: 40,
      observed_at: "2026-05-08T00:50:00Z",
    },
  ]);
  seedPerformance(services, {
    performance_id: "perf-top2-a",
    handoff_id: "handoff-top2-a",
    agent_name: "codex",
    task_type: "implement_substantial",
    outcome: "merged",
    latency_ms: 800,
  });
  seedPerformance(services, {
    performance_id: "perf-top2-b",
    handoff_id: "handoff-top2-b",
    agent_name: "gemini",
    task_type: "implement_substantial",
    outcome: "merged",
    latency_ms: 1200,
  });

  const res = await startChain(services, {
    initial_agent: "planner",
    parent_handoff_id: "h-parent-fallback-top2",
    task_type: "implement_substantial",
  });

  expect(res.status).toBe(200);
  const body = (await res.json()) as { handoff_id: string };
  const handoff = services.db
    .query<{ to_agent: string }, [string]>(`SELECT to_agent FROM handoffs WHERE handoff_id=?`)
    .get(body.handoff_id);
  expect(handoff?.to_agent).toBe("gemini");

  const events = parseFallbackPayloads(services);
  expect(events).toEqual([
    expect.objectContaining({
      original_agent: "planner",
      candidate_agent: "codex",
      candidate_state: "refuse",
      attempt_index: 0,
    }),
    expect.objectContaining({
      original_agent: "planner",
      candidate_agent: "gemini",
      candidate_state: "selected",
      attempt_index: 1,
    }),
    expect.objectContaining({
      original_agent: "planner",
      candidate_agent: "gemini",
      candidate_state: "selected",
      attempt_index: 2,
      total_attempts: 2,
      exhausted_reason: null,
    }),
  ]);
});

test("sub-agent refuse with all fallbacks refusing returns 400 and emits exhausted summary", async () => {
  const services = tempServices({
    agents: [
      { name: "maestro", pricing_mode: "subscription", subscription_provider: "anthropic" },
      { name: "planner", pricing_mode: "subscription", subscription_provider: "openai" },
      { name: "codex", pricing_mode: "subscription", subscription_provider: "groq" },
      { name: "gemini", pricing_mode: "subscription", subscription_provider: "google" },
    ],
    providerQuotas: [
      { provider: "anthropic", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
      { provider: "openai", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
      { provider: "groq", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
      { provider: "google", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
    ],
  });
  seedParentHandoff(services, { handoff_id: "h-parent-fallback-exhausted", to: "maestro" });
  seedSnapshots(services, [
    {
      event_id: "snap-fallback-exhausted-maestro",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 70,
      observed_at: "2026-05-08T00:50:00Z",
    },
    {
      event_id: "snap-fallback-exhausted-sub",
      provider: "openai",
      window_label: "five_hour",
      used_pct: 96,
      resets_at: 20_000,
      observed_at: "2026-05-08T00:50:00Z",
    },
    {
      event_id: "snap-fallback-exhausted-top1",
      provider: "groq",
      window_label: "five_hour",
      used_pct: 99,
      resets_at: 15_000,
      observed_at: "2026-05-08T00:50:00Z",
    },
    {
      event_id: "snap-fallback-exhausted-top2",
      provider: "google",
      window_label: "five_hour",
      used_pct: 99,
      resets_at: 30_000,
      observed_at: "2026-05-08T00:50:00Z",
    },
  ]);
  seedPerformance(services, {
    performance_id: "perf-exhausted-a",
    handoff_id: "handoff-exhausted-a",
    agent_name: "codex",
    task_type: "implement_substantial",
    outcome: "merged",
    latency_ms: 700,
  });
  seedPerformance(services, {
    performance_id: "perf-exhausted-b",
    handoff_id: "handoff-exhausted-b",
    agent_name: "gemini",
    task_type: "implement_substantial",
    outcome: "merged",
    latency_ms: 1100,
  });

  const res = await startChain(services, {
    initial_agent: "planner",
    parent_handoff_id: "h-parent-fallback-exhausted",
    task_type: "implement_substantial",
  });

  expect(res.status).toBe(400);
  expect(await pressureCapBody(res)).toEqual({
    error: {
      code: "subscription_pressure_capped",
      subject: "sub_agent",
      agent_name: "planner",
      provider: "openai",
      window_label: "five_hour",
      used_pct: 96,
      cap_pct: 95,
      snapshot_state: "fresh",
      snapshot_age_seconds: 600,
      resets_at: 20_000,
      earliest_resets_at: 15_000,
    },
  });

  const events = parseFallbackPayloads(services);
  expect(events).toEqual([
    expect.objectContaining({
      original_agent: "planner",
      candidate_agent: "codex",
      candidate_state: "refuse",
      attempt_index: 0,
    }),
    expect.objectContaining({
      original_agent: "planner",
      candidate_agent: "gemini",
      candidate_state: "refuse",
      attempt_index: 1,
    }),
    expect.objectContaining({
      original_agent: "planner",
      candidate_agent: null,
      candidate_state: "exhausted",
      attempt_index: 2,
      total_attempts: 2,
      exhausted_reason: "all_refused",
    }),
  ]);
});

test("both gates pass and chain_start proceeds", async () => {
  const services = tempServices({
    agents: [
      { name: "maestro", pricing_mode: "subscription", subscription_provider: "anthropic" },
      { name: "planner", pricing_mode: "subscription", subscription_provider: "openai" },
    ],
    providerQuotas: [
      { provider: "anthropic", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
      { provider: "openai", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
    ],
  });
  seedParentHandoff(services, { handoff_id: "h-parent-3", to: "maestro" });
  seedSnapshots(services, [
    {
      event_id: "snap-5",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 70,
      observed_at: "2026-05-08T00:50:00Z",
    },
    {
      event_id: "snap-6",
      provider: "openai",
      window_label: "five_hour",
      used_pct: 80,
      observed_at: "2026-05-08T00:50:00Z",
    },
  ]);

  const res = await startChain(services, {
    initial_agent: "planner",
    parent_handoff_id: "h-parent-3",
  });

  expect(res.status).toBe(200);
});

test("stale_warm snapshots return 400", async () => {
  const services = tempServices({
    agents: [
      { name: "maestro", pricing_mode: "subscription", subscription_provider: "anthropic" },
      { name: "planner", pricing_mode: "subscription", subscription_provider: "openai" },
    ],
    providerQuotas: [
      { provider: "anthropic", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
      { provider: "openai", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
    ],
  });
  seedParentHandoff(services, { handoff_id: "h-parent-4", to: "maestro" });
  seedSnapshots(services, [
    {
      event_id: "snap-7",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 60,
      observed_at: "2026-05-08T00:20:00Z",
    },
  ]);

  const res = await startChain(services, {
    initial_agent: "planner",
    parent_handoff_id: "h-parent-4",
  });

  expect(res.status).toBe(400);
  expect(await pressureCapBody(res)).toEqual({
    error: {
      code: "subscription_pressure_capped",
      subject: "maestro",
      agent_name: "maestro",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 60,
      cap_pct: 95,
      snapshot_state: "stale_warm",
      snapshot_age_seconds: 2400,
      resets_at: null,
      earliest_resets_at: null,
    },
  });
});

test("api maestro spawning subscription sub-agent only runs the sub-agent gate", async () => {
  const services = tempServices({
    agents: [
      { name: "maestro", pricing_mode: "api", subscription_provider: "anthropic" },
      { name: "planner", pricing_mode: "subscription", subscription_provider: "openai" },
    ],
    providerQuotas: [
      { provider: "anthropic", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
      { provider: "openai", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
    ],
  });
  seedParentHandoff(services, { handoff_id: "h-parent-5", to: "maestro" });
  seedSnapshots(services, [
    {
      event_id: "snap-8",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 99,
      observed_at: "2026-05-08T00:50:00Z",
    },
    {
      event_id: "snap-9",
      provider: "openai",
      window_label: "five_hour",
      used_pct: 80,
      observed_at: "2026-05-08T00:50:00Z",
    },
  ]);

  const res = await startChain(services, {
    initial_agent: "planner",
    parent_handoff_id: "h-parent-5",
  });

  expect(res.status).toBe(200);
});

test("subscription maestro spawning api sub-agent only runs the maestro gate", async () => {
  const services = tempServices({
    agents: [
      { name: "maestro", pricing_mode: "subscription", subscription_provider: "anthropic" },
      { name: "planner", pricing_mode: "api", subscription_provider: "openai" },
    ],
    providerQuotas: [
      { provider: "anthropic", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
      { provider: "openai", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
    ],
  });
  seedParentHandoff(services, { handoff_id: "h-parent-6", to: "maestro" });
  seedSnapshots(services, [
    {
      event_id: "snap-10",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 70,
      observed_at: "2026-05-08T00:50:00Z",
    },
    {
      event_id: "snap-11",
      provider: "openai",
      window_label: "five_hour",
      used_pct: 99,
      observed_at: "2026-05-08T00:50:00Z",
    },
  ]);

  const res = await startChain(services, {
    initial_agent: "planner",
    parent_handoff_id: "h-parent-6",
  });

  expect(res.status).toBe(200);
});

test("trip writes a subscription-pressure-cap-trip t0 event", async () => {
  const services = tempServices({
    agents: [
      { name: "maestro", pricing_mode: "subscription", subscription_provider: "anthropic" },
      { name: "planner", pricing_mode: "subscription", subscription_provider: "openai" },
    ],
    providerQuotas: [
      { provider: "anthropic", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
      { provider: "openai", pressure_caps: { five_hour: { warn: null, refuse: 95 } } },
    ],
  });
  seedParentHandoff(services, { handoff_id: "h-parent-7", to: "maestro" });
  seedSnapshots(services, [
    {
      event_id: "snap-12",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 96,
      observed_at: "2026-05-08T00:50:00Z",
    },
  ]);

  const res = await startChain(services, {
    initial_agent: "planner",
    parent_handoff_id: "h-parent-7",
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
  expect(row?.provider).toBe("anthropic");
  expect(JSON.parse(row?.payload_json ?? "{}")).toMatchObject({
    state: "refuse",
    reason: "over_threshold",
    provider: "anthropic",
    window_label: "five_hour",
    used_pct: 96,
    cap_pct: 95,
    snapshot_state: "fresh",
    snapshot_age_seconds: 600,
    subject: "maestro",
    trigger: "pre_dispatch",
    maestro_agent_name: "maestro",
    sub_agent_name: "planner",
  });
});
