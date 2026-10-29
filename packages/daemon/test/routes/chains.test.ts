import {
  HandoffRowSchema as ApiHandoffRowSchema,
  ChainStartResponseSchema,
} from "@penumbra/api-contract";
import { TaskRouterConfigSchema } from "@penumbra/config";
import {
  AgentPerformanceWriter,
  type AgentRoutingConfig,
  buildServices,
  ChainStartRequestSchema,
  loadSqliteVec,
  migrate,
  ProjectRegistry,
  readRoutingDecisions,
  type RecallResult,
  type Services,
  setRoutingBias,
  type Watchdog,
  type WorkflowRunsRegistry,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  chainSendMessageRoute,
  chainsHistoryRoute,
  chainsListAgentsRoute,
  chainsResponsesRoute,
  chainsStartRoute,
  chainStartFromInput,
} from "@src/routes/chains.js";
import {
  handoffsApproveRoute,
  handoffsCompleteRoute,
  handoffsCreateRoute,
  handoffsLatestRoute,
  handoffsStatusRoute,
} from "@src/routes/handoffs.js";
import type { WorkerAuthzMap } from "@src/routes/worker-profile-gate.js";
import {
  createLocalSeatHealthService,
  LOCAL_SEAT_HEALTH_TTL_MS,
  type LocalSeatHealthAgent,
} from "@src/services/local-seat-health.js";
import { createWorkflowRunsRegistry } from "@src/services/workflow-runs-registry.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch (err) {
    // best-effort: fall back to default sqlite when the homebrew build is missing
    void err;
  }
}

type ChainResponseBody = {
  ok?: boolean;
  conversation_id?: string;
  handoff_id?: string;
  branch_name?: string | null;
  requested_agent?: string;
  resolved_agent?: string;
  routed_agent?: string;
  routed_role?: string | null;
  routing_resolution_reason?: string;
  routing_task_type?: string | null;
  routing_warning?: {
    code: string;
    project_id?: string;
    suggested_project_id?: string;
    mentioned_paths?: string[];
    missing_in_project?: string[];
    hint?: string;
  };
  routing_advisory?: { code: string; project_id?: string; known_project_ids?: string[] };
  error?: {
    code?: string;
    agent?: string;
    hint?: string;
    did_you_mean?: string[];
    workers?: { worker_id: string; last_seen_age_ms: number }[];
    field_errors?: { path: string[]; message: string }[];
    project_id?: string;
    known_project_ids?: string[];
    long_lived_agent_id?: string;
    long_lived_tick_id?: string;
    message?: string;
    handoff_id?: string;
    conversation_id?: string;
    reasons?: { route_id: string; reasons: string[] }[];
  };
};

type HandoffCreateErrorBody = {
  error: {
    code: string;
    message?: string;
  };
};

const PRE_ROUTER_ROLE_RESPONSE_FIXTURE = {
  conversation_id: "conv-id-1",
  handoff_id: "id-3",
  branch_name: "feat/implement-the-change_d3",
  routed_agent: "codex-mini",
  routed_role: "executor",
  requested_agent: "executor",
  resolved_agent: "codex-mini",
  routing_resolution_reason: "role_route",
  routing_task_type: "implement_substantial",
};

type ChainHistoryBody = {
  history: { reason: string; hop_count: number; conversation_id: string }[];
};

type ChainResponseListBody = {
  responses: {
    agent: string;
    text: string;
    ts: string;
    handoff_id?: string | null;
    error?: { message: string };
  }[];
};

type ChainMessagesBody = {
  events: { event_type: string; payload: Record<string, unknown> | null; ts: string }[];
};

type ChainAgentsListBody = {
  agents: { name: string }[];
};

type HandoffRawRow = {
  handoff_id: string;
  ts: string;
  project_id: string | null;
  conversation_id: string;
  from_agent: string;
  to_agent: string;
  to_role: string | null;
  requested_agent: string | null;
  routing_resolution_reason: string | null;
  message: string;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  chain_max_hops: number | null;
  chain_trust_mode: string | null;
  chain_task_type: string | null;
  use_worktree: number | null;
  isolated_install: number | null;
  open_pr_on_review: number | null;
  branch_name: string | null;
  dispatch_kind: string | null;
  workflow_run_id: string | null;
  long_lived_agent_id: string | null;
  long_lived_tick_id: string | null;
};

type T0PayloadRow = {
  payload_json: string | Record<string, unknown> | null;
};

async function readJsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function selectHandoff(services: Services, handoff_id: string): HandoffRawRow {
  const row = services.db
    .query<HandoffRawRow, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`)
    .get(handoff_id);
  if (!row) {
    throw new Error(`handoff not found: ${handoff_id}`);
  }
  return row;
}

type WorkerSessionMock = {
  adapter?: string | null;
  inject?: (msg: { role: string; text: string }) => Promise<void> | void;
};
type WorkerManagerMock = {
  lookupSession: (handoff_id: string) => Promise<WorkerSessionMock | null>;
};
function installWorkerManager(services: Services, mock: WorkerManagerMock): void {
  services.workerManager = mock;
}

function noopLog(): undefined {
  return undefined;
}

function tempServices(opts?: {
  agentRegistry?: string[] | null;
  agentRouting?: AgentRoutingConfig | null;
  projectRegistry?: ProjectRegistry;
}): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/chains-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-26T00:00:00Z"),
    uuid: () => `id-${String(++n)}`,
    agentRegistry: opts?.agentRegistry,
    agentRouting: opts?.agentRouting,
    worktreeRootDir: "/private/tmp/penumbra-test-worktrees",
  });
  services.projectRegistry = opts?.projectRegistry;
  // Mock watchdog for chains testing (by default hasActiveWorker=true to pass existing tests)
  const watchdog: Watchdog = {
    recordHeartbeat: (): void => undefined,
    hasActiveWorker: (): boolean => true,
    getStaleWorkers: (): string[] => [],
    getStaleHeartbeatAges: (): { worker_id: string; last_seen_age_ms: number }[] => [],
    tick: (): Promise<void> => Promise.resolve(),
  };
  services.watchdog = watchdog;
  return services;
}

let previousDaemonRequireExplicitProjectId: string | undefined;
let previousRequirePromptProjectMatch: string | undefined;
let previousIsolatedInstallAuto: string | undefined;
let previousIsolatedInstallAutoBoundary: string | undefined;
let previousAutoRecallEnabled: string | undefined;

beforeEach(() => {
  previousDaemonRequireExplicitProjectId = process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
  previousRequirePromptProjectMatch = process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;
  previousIsolatedInstallAuto = process.env.PENUMBRA_ISOLATED_INSTALL_AUTO;
  previousIsolatedInstallAutoBoundary = process.env.PENUMBRA_ISOLATED_INSTALL_AUTO_BOUNDARY;
  previousAutoRecallEnabled = process.env.PENUMBRA_AUTO_RECALL_ENABLED;
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
  delete process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;
  delete process.env.PENUMBRA_ISOLATED_INSTALL_AUTO;
  delete process.env.PENUMBRA_ISOLATED_INSTALL_AUTO_BOUNDARY;
  delete process.env.PENUMBRA_AUTO_RECALL_ENABLED;
});

afterEach(() => {
  if (previousDaemonRequireExplicitProjectId === undefined) {
    delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
  } else {
    process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID =
      previousDaemonRequireExplicitProjectId;
  }
  if (previousRequirePromptProjectMatch === undefined) {
    delete process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;
  } else {
    process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = previousRequirePromptProjectMatch;
  }
  if (previousIsolatedInstallAuto === undefined) {
    delete process.env.PENUMBRA_ISOLATED_INSTALL_AUTO;
  } else {
    process.env.PENUMBRA_ISOLATED_INSTALL_AUTO = previousIsolatedInstallAuto;
  }
  if (previousIsolatedInstallAutoBoundary === undefined) {
    delete process.env.PENUMBRA_ISOLATED_INSTALL_AUTO_BOUNDARY;
  } else {
    process.env.PENUMBRA_ISOLATED_INSTALL_AUTO_BOUNDARY = previousIsolatedInstallAutoBoundary;
  }
  if (previousAutoRecallEnabled === undefined) {
    delete process.env.PENUMBRA_AUTO_RECALL_ENABLED;
  } else {
    process.env.PENUMBRA_AUTO_RECALL_ENABLED = previousAutoRecallEnabled;
  }
});

test("chainStartFromInput accepts every canonical dispatch_kind value", async () => {
  const canonicalDispatchKinds = ChainStartRequestSchema.shape.dispatch_kind.unwrap().options;

  for (const dispatchKind of canonicalDispatchKinds) {
    const services = tempServices();
    const longLivedFields =
      dispatchKind === "long_lived_tick"
        ? {
            long_lived_agent_id: "agent-42",
            long_lived_tick_id: "tick-42",
          }
        : {};
    if (dispatchKind === "long_lived_tick") {
      services.db
        .query(
          `INSERT INTO long_lived_agents (
          id, display_name, working_memory_json, standing_brief, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "agent-42",
          "Home Assistant",
          JSON.stringify({
            version: 1,
            updated_at: 1715385600000,
            pending_goals: [],
            open_threads: [],
            watches: [],
            recent_decisions: [],
          }),
          "Keep home automations healthy",
          1715385600000,
          1715385600000,
        );
      services.db
        .query(
          `INSERT INTO long_lived_ticks (
          id, agent_id, trigger_kind, started_at
        ) VALUES (?, ?, ?, ?)`,
        )
        .run("tick-42", "agent-42", "manual", 1715385600000);
    }
    const res = await chainStartFromInput(
      {
        initial_agent: "codex",
        message: "hi",
        dispatch_kind: dispatchKind,
        ...longLivedFields,
      },
      services,
    );

    expect(res.status, dispatchKind).toBe(200);
  }
});

function seedPerformance(
  services: Services,
  input: {
    performance_id: string;
    handoff_id: string;
    agent_name: string;
    task_type: "implement_small" | "implement_substantial" | "review_adversarial";
    outcome: "merged" | "failed";
    rounds?: number;
    smoke_pass?: "y" | "n";
  },
): void {
  new AgentPerformanceWriter(services.db).upsert({
    performance_id: input.performance_id,
    ts: "2026-04-25T00:00:00.000Z",
    handoff_id: input.handoff_id,
    conversation_id: "conv-ledger",
    project_id: null,
    agent_name: input.agent_name,
    task_type: input.task_type,
    outcome: input.outcome,
    rounds: input.rounds ?? 1,
    smoke_pass: input.smoke_pass ?? "y",
    reviewer_findings: null,
    maestro_score: 5,
    cost_usd: 100,
    tokens_used: null,
    latency_ms: null,
    source: "manual_seed",
    notes: null,
    metadata_json: "{}",
  });
}

function seedSubscriptionPressure(services: Services, provider: string, usedPct: number): void {
  const now = services.clock().toISOString();
  services.db
    .prepare(
      `INSERT INTO t0_events (
        event_id, ts, ingest_ts, source, user_id, machine_id,
        event_type, lane, provider, payload_json
      ) VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'rate-limit-snapshot', 'cli-subscription', ?, ?)`,
    )
    .run(
      `pressure-${provider}`,
      now,
      now,
      provider,
      JSON.stringify({
        window_label: "24h",
        model: null,
        used_pct: usedPct,
        resets_at: null,
        source_kind: "subscription",
      }),
    );
}

function writeAgentResponse(
  services: Services,
  input: {
    event_id: string;
    ts: string;
    ingest_ts?: string;
    source?: string;
    source_detail?: string | null;
    user_id?: string;
    session_id: string;
    payload_json: Record<string, unknown>;
  },
): void {
  services.t0Writer.write({
    event_id: input.event_id,
    ts: input.ts,
    ingest_ts: input.ingest_ts ?? input.ts,
    source: input.source ?? "agentchat",
    source_detail: input.source_detail ?? null,
    project_id: null,
    user_id: input.user_id ?? "u1",
    machine_id: "m1",
    session_id: input.session_id,
    event_type: "agent-response",
    lane: "local",
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: input.payload_json,
    payload_summary: "response",
  });
}

function writeConversationMarker(services: Services, session_id: string): void {
  services.t0Writer.write({
    event_id: `marker-${session_id}`,
    ts: "2026-04-26T11:00:00Z",
    ingest_ts: "2026-04-26T11:00:00Z",
    source: "agentchat",
    source_detail: "chain-start",
    project_id: null,
    user_id: "local-user",
    machine_id: "m1",
    session_id,
    event_type: "user-prompt",
    lane: "local",
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: { prompt: "hi" },
    payload_summary: "hi",
  });
}

async function createHandoff(services: Services, conversation_id: string): Promise<string> {
  const res = await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "user",
        to: "agent",
        message: "go",
        conversation_id,
        triggered_by_event_id: "evt-1",
      }),
    }),
    services,
  );
  const body = (await res.json()) as { handoff_id: string };
  return body.handoff_id;
}

test("POST /chains/start returns 400 if initial_agent is not in registry", async () => {
  const services = tempServices({ agentRegistry: ["planner", "executor"] });
  const warnSpy = spyOn(services.log, "warn").mockImplementation(noopLog);
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "bogus-agent", message: "hi" }),
    }),
    services,
  );
  expect(res.status).toBe(400);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error.code).toBe("unknown_agent");
  expect(body.error.agent).toBe("bogus-agent");
  expect(body.error.hint).toBe("use chain.list_agents to enumerate valid agents");
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      initial_agent: "bogus-agent",
      registry_size: 2,
    }),
    expect.stringContaining("unknown agent"),
  );
});

test("POST /chains/start does not run DDL on the request path", async () => {
  const services = tempServices();
  const ddlRe = /\b(?:PRAGMA|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE)\b/i;
  const querySpy = spyOn(services.db, "query");

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "codex", message: "hi" }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const ddlCalls = querySpy.mock.calls
    .map((args) => (typeof args[0] === "string" ? args[0] : ""))
    .filter((sql) => ddlRe.test(sql));
  expect(ddlCalls).toEqual([]);
});

test("POST /chains/start clears auto-recall timeout when recall wins race", async () => {
  const services = tempServices({ agentRegistry: ["codex"] });
  services.projectRegistry = new ProjectRegistry(
    new Map([["penumbra", { project_id: "penumbra", root_path: "/tmp/penumbra" }]]),
  );
  services.recallReader.recall = (): Promise<[]> => Promise.resolve([]);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const armed: { handle: ReturnType<typeof setTimeout>; timeout: number | undefined }[] = [];
  const cleared: ReturnType<typeof setTimeout>[] = [];
  globalThis.setTimeout = ((callback: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const handle = originalSetTimeout(callback as (...args: never[]) => void, timeout, ...args);
    armed.push({ handle, timeout });
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
    if (handle !== undefined) cleared.push(handle);
    originalClearTimeout(handle);
  }) as typeof clearTimeout;

  try {
    const res = await chainsStartRoute(
      new Request("http://x/chains/start", {
        method: "POST",
        body: JSON.stringify({
          initial_agent: "codex",
          message: "hi",
          project_id: "penumbra",
          task_class: "STANDARD",
        }),
      }),
      services,
    );

    expect(res.status).toBe(200);
    expect(armed.filter(({ timeout }) => timeout === 1500)).toHaveLength(1);
    expect(armed.filter(({ handle }) => !cleared.includes(handle))).toEqual([]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    for (const { handle } of armed) originalClearTimeout(handle);
  }
});

test("POST /chains/start allows missing project_id when daemon hard-mode gate is unset", async () => {
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "codex", message: "hi" }),
    }),
    services,
  );

  expect(res.status).toBe(200);
});

test("POST /chains/start rejects missing project_id when daemon hard-mode gate is enabled", async () => {
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "codex", message: "hi" }),
    }),
    services,
  );

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: "project_id_required",
    hint: "pass project_id explicitly, or unset PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy behavior",
  });
});

test("POST /chains/start rejects missing project_id when no dispatch exemption is present", async () => {
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  const services = tempServices();
  services.db
    .query(
      `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-42",
      "Home Assistant",
      JSON.stringify({
        version: 1,
        updated_at: 1715385600000,
        pending_goals: [],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      }),
      "Keep home automations healthy",
      1715385600000,
      1715385600000,
    );
  services.db
    .query(
      `INSERT INTO long_lived_ticks (
      id, agent_id, trigger_kind, started_at
    ) VALUES (?, ?, ?, ?)`,
    )
    .run("tick-42", "agent-42", "manual", 1715385600000);

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "codex",
        message: "hi",
        dispatch_kind: "long_lived_tick",
      }),
    }),
    services,
  );

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: "project_id_required",
    hint: "pass project_id explicitly, or unset PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy behavior",
  });
});

test("POST /chains/start rejects long_lived_tick exemption when long_lived_agent_id is missing", async () => {
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  const services = tempServices();
  services.db
    .query(
      `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-42",
      "Home Assistant",
      JSON.stringify({
        version: 1,
        updated_at: 1715385600000,
        pending_goals: [],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      }),
      "Keep home automations healthy",
      1715385600000,
      1715385600000,
    );
  services.db
    .query(
      `INSERT INTO long_lived_ticks (
      id, agent_id, trigger_kind, started_at
    ) VALUES (?, ?, ?, ?)`,
    )
    .run("tick-42", "agent-42", "manual", 1715385600000);

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "codex",
        message: "hi",
        dispatch_kind: "long_lived_tick",
        long_lived_tick_id: "tick-42",
      }),
    }),
    services,
  );

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: "project_id_required",
    hint: "pass project_id explicitly, or unset PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy behavior",
  });
});

test("POST /chains/start rejects long_lived_tick exemption when long_lived_agent_id does not match the tick", async () => {
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  const services = tempServices();
  services.db
    .query(
      `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-42",
      "Home Assistant",
      JSON.stringify({
        version: 1,
        updated_at: 1715385600000,
        pending_goals: [],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      }),
      "Keep home automations healthy",
      1715385600000,
      1715385600000,
    );
  services.db
    .query(
      `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-99",
      "Other Agent",
      JSON.stringify({
        version: 1,
        updated_at: 1715385600000,
        pending_goals: [],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      }),
      "Other agent",
      1715385600000,
      1715385600000,
    );
  services.db
    .query(
      `INSERT INTO long_lived_ticks (
      id, agent_id, trigger_kind, started_at
    ) VALUES (?, ?, ?, ?)`,
    )
    .run("tick-42", "agent-42", "manual", 1715385600000);

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "codex",
        message: "hi",
        dispatch_kind: "long_lived_tick",
        long_lived_agent_id: "agent-99",
        long_lived_tick_id: "tick-42",
      }),
    }),
    services,
  );

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: "project_id_required",
    hint: "pass project_id explicitly, or unset PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy behavior",
  });
});

test("POST /chains/start rejects long_lived_tick exemption when the tick is completed", async () => {
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  const services = tempServices();
  services.db
    .query(
      `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-42",
      "Home Assistant",
      JSON.stringify({
        version: 1,
        updated_at: 1715385600000,
        pending_goals: [],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      }),
      "Keep home automations healthy",
      1715385600000,
      1715385600000,
    );
  services.db
    .query(
      `INSERT INTO long_lived_ticks (
      id, agent_id, trigger_kind, started_at, completed_at, outcome
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("tick-42", "agent-42", "manual", 1715385600000, 1715385601000, "success");

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "codex",
        message: "hi",
        dispatch_kind: "long_lived_tick",
        long_lived_agent_id: "agent-42",
        long_lived_tick_id: "tick-42",
      }),
    }),
    services,
  );

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: "project_id_required",
    hint: "pass project_id explicitly, or unset PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy behavior",
  });
});

test("POST /chains/start exempts long_lived_tick dispatches with a valid tick id from the explicit project gate", async () => {
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  const services = tempServices();
  services.db
    .query(
      `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-42",
      "Home Assistant",
      JSON.stringify({
        version: 1,
        updated_at: 1715385600000,
        pending_goals: [],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      }),
      "Keep home automations healthy",
      1715385600000,
      1715385600000,
    );
  services.db
    .query(
      `INSERT INTO long_lived_ticks (
      id, agent_id, trigger_kind, started_at
    ) VALUES (?, ?, ?, ?)`,
    )
    .run("tick-42", "agent-42", "manual", 1715385600000);

  const logSpy = spyOn(services.log, "info").mockImplementation(noopLog);
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "codex",
        message: "hi",
        dispatch_kind: "long_lived_tick",
        long_lived_agent_id: "agent-42",
        long_lived_tick_id: "tick-42",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  expect(logSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "chain_start.routing_guard.explicit_gate_exempted",
      dispatch_kind: "long_lived_tick",
      long_lived_tick_id: "tick-42",
      workflow_run_id: null,
    }),
    expect.any(String),
  );
});

test("POST /chains/start rejects forged long_lived_tick dispatch exemptions", async () => {
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  const services = tempServices();

  const missingTickRes = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "codex",
        message: "hi",
        dispatch_kind: "long_lived_tick",
        long_lived_agent_id: "agent-42",
        long_lived_tick_id: "missing-tick",
      }),
    }),
    services,
  );
  expect(missingTickRes.status).toBe(400);
  expect(await missingTickRes.json()).toEqual({
    error: "project_id_required",
    hint: "pass project_id explicitly, or unset PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy behavior",
  });

  const missingIdRes = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "codex",
        message: "hi",
        dispatch_kind: "long_lived_tick",
      }),
    }),
    services,
  );
  expect(missingIdRes.status).toBe(400);
  expect(await missingIdRes.json()).toEqual({
    error: "project_id_required",
    hint: "pass project_id explicitly, or unset PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy behavior",
  });
});

test("POST /chains/start exempts workflow dispatches with a valid run id from the explicit project gate", async () => {
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  const services = tempServices();
  const workflowRunsMock: WorkflowRunsRegistry = {
    verify: (workflowRunId: string) =>
      workflowRunId === "workflow-42"
        ? { workflow_name: "operator1", project_id: null, registered_at: 1715385600000 }
        : null,
    register: (): null => null,
    unregister: (): undefined => undefined,
    recordResult: (): Promise<void> => Promise.resolve(),
    recordError: (): Promise<void> => Promise.resolve(),
    getStatus: (): Promise<null> => Promise.resolve(null),
    getStatusLight: (): Promise<null> => Promise.resolve(null),
    waitForResult: (): Promise<null> => Promise.resolve(null),
    setPersistenceStatus: (): void => undefined,
    setExecutionRecord: (): void => undefined,
  };
  services.workflowRuns = workflowRunsMock;

  const logSpy = spyOn(services.log, "info").mockImplementation(noopLog);
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "codex",
        message: "hi",
        dispatch_kind: "workflow",
        workflow_run_id: "workflow-42",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  expect(logSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "chain_start.routing_guard.explicit_gate_exempted",
      dispatch_kind: "workflow",
      long_lived_tick_id: null,
      workflow_run_id: "workflow-42",
    }),
    expect.any(String),
  );
});

test("POST /chains/start persists workflow_run_id on workflow dispatch handoffs", async () => {
  const services = tempServices({ agentRegistry: ["planner"] });
  const workflowRunsMock: WorkflowRunsRegistry = {
    verify: (workflowRunId: string) =>
      workflowRunId === "wfrun-persist-1"
        ? { workflow_name: "test-workflow", project_id: null, registered_at: 1715385600000 }
        : null,
    register: (): null => null,
    unregister: (): undefined => undefined,
    recordResult: (): Promise<void> => Promise.resolve(),
    recordError: (): Promise<void> => Promise.resolve(),
    getStatus: (): Promise<null> => Promise.resolve(null),
    getStatusLight: (): Promise<null> => Promise.resolve(null),
    waitForResult: (): Promise<null> => Promise.resolve(null),
    setPersistenceStatus: (): void => undefined,
    setExecutionRecord: (): void => undefined,
  };
  services.workflowRuns = workflowRunsMock;

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        dispatch_kind: "workflow",
        workflow_run_id: "wfrun-persist-1",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.dispatch_kind).toBe("workflow");
  expect(handoff.workflow_run_id).toBe("wfrun-persist-1");
});

test("POST /chains/start exempts thought_analyzer dispatches with missing project_id but rejects normal dispatches under strict mode", async () => {
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  const services = tempServices();
  const logSpy = spyOn(services.log, "info").mockImplementation(noopLog);

  const thoughtAnalyzerRes = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "codex",
        message: "hi",
        dispatch_kind: "thought_analyzer",
      }),
    }),
    services,
  );

  expect(thoughtAnalyzerRes.status).toBe(200);
  expect(logSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "chain_start.routing_guard.explicit_gate_exempted",
      dispatch_kind: "thought_analyzer",
      long_lived_tick_id: null,
      workflow_run_id: null,
    }),
    expect.any(String),
  );

  const normalRes = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "codex", message: "hi" }),
    }),
    services,
  );

  expect(normalRes.status).toBe(400);
  expect(await normalRes.json()).toEqual({
    error: "project_id_required",
    hint: "pass project_id explicitly, or unset PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy behavior",
  });
});

test("POST /chains/start rejects null project_id when daemon hard-mode gate is enabled", async () => {
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = "true";
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "codex", message: "hi", project_id: null }),
    }),
    services,
  );

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: "project_id_required",
    hint: "pass project_id explicitly, or unset PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy behavior",
  });
});

test("POST /chains/start allows explicit project_id when daemon hard-mode gate is enabled", async () => {
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = "on";
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "codex", message: "hi", project_id: "proj-123" }),
    }),
    services,
  );

  expect(res.status).toBe(200);
});

test("POST /chains/:handoff_id/messages injects content into a running ACP session", async () => {
  const services = tempServices();
  const handoff_id = await createHandoff(services, "conv-running");

  const injected: { role: string; text: string }[] = [];
  installWorkerManager(services, {
    lookupSession: (): Promise<WorkerSessionMock> =>
      Promise.resolve({
        adapter: "claude-acp-sonnet",
        inject: (message: { role: string; text: string }): void => {
          injected.push(message);
        },
      }),
  });

  const res = await chainSendMessageRoute(
    new Request(`http://x/chains/${handoff_id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "answer the question" }),
    }),
    handoff_id,
    services,
  );

  expect(res.status).toBe(200);
  expect(await readJsonBody<ChainResponseBody>(res)).toEqual({ ok: true });
  expect(injected).toEqual([{ role: "user", text: "answer the question" }]);
});

test("POST /chains/:handoff_id/messages returns 404 for an unknown handoff", async () => {
  const services = tempServices();
  installWorkerManager(services, {
    lookupSession: (): Promise<null> => Promise.resolve(null),
  });

  const res = await chainSendMessageRoute(
    new Request("http://x/chains/h-missing/messages", {
      method: "POST",
      body: JSON.stringify({ content: "hello" }),
    }),
    "h-missing",
    services,
  );

  expect(res.status).toBe(404);
});

test("POST /chains/:handoff_id/messages returns 409 when the adapter does not support injection", async () => {
  const services = tempServices();
  const handoff_id = await createHandoff(services, "conv-unsupported");
  installWorkerManager(services, {
    lookupSession: (): Promise<WorkerSessionMock> => Promise.resolve({ adapter: null }),
  });

  const res = await chainSendMessageRoute(
    new Request(`http://x/chains/${handoff_id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "hello" }),
    }),
    handoff_id,
    services,
  );

  expect(res.status).toBe(409);
});

test("POST /chains/:handoff_id/messages returns 410 for a terminal handoff", async () => {
  const services = tempServices();
  const handoff_id = await createHandoff(services, "conv-terminal");
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${handoff_id}/approve`, { method: "POST", body: "{}" }),
    handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(handoff_id, "worker-1");
  await handoffsCompleteRoute(
    new Request(`http://x/handoffs/${handoff_id}/complete`, { method: "POST" }),
    handoff_id,
    services,
  );
  installWorkerManager(services, {
    lookupSession: (): Promise<null> => Promise.resolve(null),
  });

  const res = await chainSendMessageRoute(
    new Request(`http://x/chains/${handoff_id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "hello" }),
    }),
    handoff_id,
    services,
  );

  expect(res.status).toBe(410);
});

test("POST /chains/:handoff_id/messages returns 400 for missing content", async () => {
  const services = tempServices();
  const handoff_id = await createHandoff(services, "conv-empty");
  const res = await chainSendMessageRoute(
    new Request(`http://x/chains/${handoff_id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "" }),
    }),
    handoff_id,
    services,
  );
  expect(res.status).toBe(400);
});

test("POST /chains/start succeeds if initial_agent is in registry", async () => {
  const services = tempServices({ agentRegistry: ["planner", "executor"] });
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "planner", message: "hi" }),
    }),
    services,
  );
  expect(res.status).toBe(200);
});

test("POST /chains/start routes role targets to the best ledger-ranked role agent", async () => {
  const routing: AgentRoutingConfig = {
    agents: [
      { name: "gemini", roles: ["executor"] },
      { name: "codex-mini", roles: ["executor"] },
    ],
    default_roles: { executor: "gemini" },
  };
  const services = tempServices({ agentRegistry: ["gemini", "codex-mini"], agentRouting: routing });
  seedPerformance(services, {
    performance_id: "p-good",
    handoff_id: "h-good",
    agent_name: "codex-mini",
    task_type: "implement_substantial",
    outcome: "merged",
    rounds: 1,
    smoke_pass: "y",
  });
  seedPerformance(services, {
    performance_id: "p-bad",
    handoff_id: "h-bad",
    agent_name: "gemini",
    task_type: "implement_substantial",
    outcome: "failed",
    rounds: 4,
    smoke_pass: "n",
  });

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "executor",
        task_type: "implement_substantial",
        message: "implement the change",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body).toEqual(PRE_ROUTER_ROLE_RESPONSE_FIXTURE);
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.requested_agent).toBe("executor");
  expect(handoff.to_agent).toBe("codex-mini");
  expect(handoff.to_role).toBe("executor");
  expect(handoff.routing_resolution_reason).toBe("role_route");
});

test("POST /chains/start treats a name that is also a configured role as a role target", async () => {
  const routing: AgentRoutingConfig = {
    agents: [
      { name: "executor", roles: ["executor"] },
      { name: "codex-spark", roles: ["executor"] },
    ],
    default_roles: { executor: "executor" },
  };
  const services = tempServices({
    agentRegistry: ["executor", "codex-spark"],
    agentRouting: routing,
  });

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "executor",
        task_type: "implement_substantial",
        message: "implement the change",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.routed_agent).toBe("codex-spark");
  expect(body.routed_role).toBe("executor");
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.to_agent).toBe("codex-spark");
  expect(handoff.to_role).toBe("executor");
});

test("POST /chains/start supports agent: prefix to force exact routing through a role collision", async () => {
  const routing: AgentRoutingConfig = {
    agents: [
      { name: "executor", roles: ["executor"] },
      { name: "codex-spark", roles: ["executor"] },
    ],
    default_roles: { executor: "executor" },
  };
  const services = tempServices({
    agentRegistry: ["executor", "codex-spark"],
    agentRouting: routing,
  });

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "agent:executor",
        task_type: "implement_small",
        message: "implement the change",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.routed_agent).toBeUndefined();
  expect(body.routed_role).toBeUndefined();
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.to_agent).toBe("executor");
  expect(handoff.to_role).toBeNull();
  expect(handoff.chain_task_type).toBe("implement_small");
});

test("POST /chains/start treats exact agent names as explicit routing even when role ranking exists", async () => {
  const routing: AgentRoutingConfig = {
    agents: [
      { name: "gemini", roles: ["executor"] },
      { name: "codex-mini", roles: ["executor"] },
    ],
    default_roles: { executor: "gemini" },
  };
  const services = tempServices({ agentRegistry: ["gemini", "codex-mini"], agentRouting: routing });
  seedPerformance(services, {
    performance_id: "p-good",
    handoff_id: "h-good",
    agent_name: "codex-mini",
    task_type: "implement_substantial",
    outcome: "merged",
  });

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "gemini",
        task_type: "implement_substantial",
        message: "implement the change",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.routed_agent).toBeUndefined();
  expect(body.routed_role).toBeUndefined();
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.to_agent).toBe("gemini");
  expect(handoff.to_role).toBeNull();
});

test("POST /chains/start explores an unsampled non-default role agent before the default", async () => {
  const routing: AgentRoutingConfig = {
    agents: [
      { name: "gemini", roles: ["executor"] },
      { name: "codex-mini", roles: ["executor"] },
    ],
    default_roles: { executor: "gemini" },
  };
  const services = tempServices({ agentRegistry: ["gemini", "codex-mini"], agentRouting: routing });

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "executor",
        task_type: "implement_substantial",
        message: "implement the change",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.routed_agent).toBe("codex-mini");
  expect(body.routed_role).toBe("executor");
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.to_agent).toBe("codex-mini");
  expect(handoff.to_role).toBe("executor");
  expect(handoff.chain_task_type).toBe("implement_substantial");
});

test("POST /chains/start honors ranked-first exploration policy for role routing", async () => {
  const routing = {
    agents: [
      { name: "gemini", roles: ["executor"] },
      { name: "codex-mini", roles: ["executor"] },
    ],
    default_roles: { executor: "gemini" },
    role_exploration_policy: "ranked-first",
  } satisfies AgentRoutingConfig & { role_exploration_policy: "ranked-first" };
  const services = tempServices({ agentRegistry: ["gemini", "codex-mini"], agentRouting: routing });
  seedPerformance(services, {
    performance_id: "p-good",
    handoff_id: "h-good",
    agent_name: "gemini",
    task_type: "implement_substantial",
    outcome: "merged",
    rounds: 1,
    smoke_pass: "y",
  });

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "executor",
        task_type: "implement_substantial",
        message: "implement the change",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.routed_agent).toBe("gemini");
  expect(body.routed_role).toBe("executor");
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.to_agent).toBe("gemini");
  expect(handoff.to_role).toBe("executor");
});

test("POST /chains/start falls back to default role agent when no alternate needs exploration", async () => {
  const routing: AgentRoutingConfig = {
    agents: [{ name: "gemini", roles: ["executor"] }],
    default_roles: { executor: "gemini" },
  };
  const services = tempServices({ agentRegistry: ["gemini"], agentRouting: routing });

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "executor",
        task_type: "implement_substantial",
        message: "implement the change",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.routed_agent).toBe("gemini");
  expect(body.routed_role).toBe("executor");
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.to_agent).toBe("gemini");
  expect(handoff.to_role).toBe("executor");
});

test("chain-start rejects unknown explicit project_id from external callers without persisting a handoff", async () => {
  const services = tempServices({ agentRegistry: ["planner"] });
  services.projectRegistry = new ProjectRegistry(
    new Map([["penumbra", { project_id: "penumbra", root_path: "/tmp/penumbra" }]]),
  );
  const recallSpy = spyOn(services.recallReader, "recall");
  const warnSpy = spyOn(services.log, "warn").mockImplementation(noopLog);

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "hi",
      project_id: "not-in-registry",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(400);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error).toEqual({
    code: "unknown_project",
    project_id: "not-in-registry",
    known_project_ids: ["penumbra"],
    hint: "pass a project_id present in the project registry",
  });
  const handoffCount =
    services.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM handoffs").get()?.c ?? 0;
  expect(handoffCount).toBe(0);
  expect(
    services.db.query("SELECT event_type FROM t0_events WHERE event_type = 'user-prompt'").all(),
  ).toEqual([]);
  expect(recallSpy).not.toHaveBeenCalled();
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "chain_start.unknown_project_id_rejected",
      project_id: "not-in-registry",
      known_project_ids: ["penumbra"],
    }),
    "chain-start unknown_project_id; rejecting",
  );
});

test("chain-start preserves routing errors before unknown project_id rejection", async () => {
  const services = tempServices({ agentRegistry: ["planner"] });
  services.projectRegistry = new ProjectRegistry(
    new Map([["penumbra", { project_id: "penumbra", root_path: "/tmp/penumbra" }]]),
  );
  const res = await chainsStartRoute(
    new Request("http://t/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "missing-agent",
        message: "hi",
        project_id: "not-in-registry",
      }),
    }),
    services,
  );
  expect(res.status).toBe(400);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error?.code).toBe("unknown_agent");
  expect(services.db.query("SELECT handoff_id FROM handoffs").all()).toEqual([]);
});

test("chain-start drops unknown project_id for valid internal workflow dispatches and returns an advisory", async () => {
  const services = tempServices({ agentRegistry: ["planner"] });
  services.projectRegistry = new ProjectRegistry(
    new Map([["penumbra", { project_id: "penumbra", root_path: "/tmp/penumbra" }]]),
  );
  const workflowRunsMock: WorkflowRunsRegistry = {
    verify: (workflowRunId: string) =>
      workflowRunId === "workflow-42"
        ? { workflow_name: "operator1", project_id: null, registered_at: 1715385600000 }
        : null,
    register: (): null => null,
    unregister: (): undefined => undefined,
    recordResult: (): Promise<void> => Promise.resolve(),
    recordError: (): Promise<void> => Promise.resolve(),
    getStatus: (): Promise<null> => Promise.resolve(null),
    getStatusLight: (): Promise<null> => Promise.resolve(null),
    waitForResult: (): Promise<null> => Promise.resolve(null),
    setPersistenceStatus: (): void => undefined,
    setExecutionRecord: (): void => undefined,
  };
  services.workflowRuns = workflowRunsMock;
  const warnSpy = spyOn(services.log, "warn").mockImplementation(noopLog);

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "hi",
      project_id: "not-in-registry",
      dispatch_kind: "workflow",
      workflow_run_id: "workflow-42",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.routing_advisory).toEqual({
    code: "unknown_project_id_dropped",
    project_id: "not-in-registry",
    known_project_ids: ["penumbra"],
  });
  expect(() => ChainStartResponseSchema.parse(body)).not.toThrow();
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.project_id).toBeNull();
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "chain_start.unknown_project_id_dropped",
      project_id: "not-in-registry",
      known_project_ids: ["penumbra"],
    }),
    "chain-start unknown_project_id; dropping and continuing",
  );
});

test("chain-start drops unknown project_id for thought_analyzer dispatches and returns an advisory", async () => {
  const services = tempServices({ agentRegistry: ["planner"] });
  services.projectRegistry = new ProjectRegistry(
    new Map([["penumbra", { project_id: "penumbra", root_path: "/tmp/penumbra" }]]),
  );

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "hi",
      project_id: "not-in-registry",
      dispatch_kind: "thought_analyzer",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.routing_advisory).toEqual({
    code: "unknown_project_id_dropped",
    project_id: "not-in-registry",
    known_project_ids: ["penumbra"],
  });
  expect(() => ChainStartResponseSchema.parse(body)).not.toThrow();
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.project_id).toBeNull();
});

test("chain-start drops unknown project_id for valid long-lived dispatches and returns an advisory", async () => {
  const services = tempServices({ agentRegistry: ["planner"] });
  services.projectRegistry = new ProjectRegistry(
    new Map([["penumbra", { project_id: "penumbra", root_path: "/tmp/penumbra" }]]),
  );
  services.db
    .query(
      `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-42",
      "Home Assistant",
      JSON.stringify({
        version: 1,
        updated_at: 1715385600000,
        pending_goals: [],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      }),
      "Keep home automations healthy",
      1715385600000,
      1715385600000,
    );
  services.db
    .query(
      `INSERT INTO long_lived_ticks (
      id, agent_id, trigger_kind, started_at
    ) VALUES (?, ?, ?, ?)`,
    )
    .run("tick-42", "agent-42", "manual", 1715385600000);

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "hi",
      project_id: "not-in-registry",
      dispatch_kind: "long_lived_tick",
      long_lived_agent_id: "agent-42",
      long_lived_tick_id: "tick-42",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.routing_advisory).toEqual({
    code: "unknown_project_id_dropped",
    project_id: "not-in-registry",
    known_project_ids: ["penumbra"],
  });
  expect(() => ChainStartResponseSchema.parse(body)).not.toThrow();
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.project_id).toBeNull();
});

test("chain-start treats forged workflow metadata as external for unknown project_id rejection", async () => {
  const services = tempServices({ agentRegistry: ["planner"] });
  services.projectRegistry = new ProjectRegistry(
    new Map([["penumbra", { project_id: "penumbra", root_path: "/tmp/penumbra" }]]),
  );
  const workflowRunsMock: WorkflowRunsRegistry = {
    verify: (): null => null,
    register: (): null => null,
    unregister: (): undefined => undefined,
    recordResult: (): Promise<void> => Promise.resolve(),
    recordError: (): Promise<void> => Promise.resolve(),
    getStatus: (): Promise<null> => Promise.resolve(null),
    getStatusLight: (): Promise<null> => Promise.resolve(null),
    waitForResult: (): Promise<null> => Promise.resolve(null),
    setPersistenceStatus: (): void => undefined,
    setExecutionRecord: (): void => undefined,
  };
  services.workflowRuns = workflowRunsMock;

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "hi",
      project_id: "not-in-registry",
      dispatch_kind: "workflow",
      workflow_run_id: "not-real",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(400);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error?.code).toBe("unknown_project");
  const handoffCount =
    services.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM handoffs").get()?.c ?? 0;
  expect(handoffCount).toBe(0);
});

test("chain-start accepts a project_id present in the registry", async () => {
  const services = tempServices({ agentRegistry: ["planner"] });
  services.projectRegistry = new ProjectRegistry(
    new Map([["penumbra", { project_id: "penumbra", root_path: "/tmp/penumbra" }]]),
  );

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "hi",
      project_id: "penumbra",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
});

test("chain-start skips routing guard when project_id is null even with a populated registry", async () => {
  const services = tempServices({
    agentRegistry: ["planner"],
    projectRegistry: new ProjectRegistry(
      new Map([
        [
          "penumbra",
          { project_id: "penumbra", root_path: "/Volumes/WorkSSD/repos/personal/penumbra" },
        ],
        [
          "llamactl",
          { project_id: "llamactl", root_path: "/Volumes/WorkSSD/repos/personal/llamactl" },
        ],
      ]),
    ),
  });

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.routing_warning).toBeUndefined();
  expect(body.routing_advisory).toBeUndefined();
});

test("chain-start attaches a routing warning and dispatches when strict mode is off", async () => {
  const services = tempServices({
    agentRegistry: ["planner"],
    projectRegistry: new ProjectRegistry(
      new Map([
        [
          "penumbra",
          { project_id: "penumbra", root_path: "/Volumes/WorkSSD/repos/personal/penumbra" },
        ],
        [
          "llamactl",
          { project_id: "llamactl", root_path: "/Volumes/WorkSSD/repos/personal/llamactl" },
        ],
      ]),
    ),
  });
  delete process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
      project_id: "penumbra",
      task_class: "STANDARD",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body).toHaveProperty(
    "routing_warning",
    expect.objectContaining({
      code: "prompt_project_mismatch",
      project_id: "penumbra",
      mentioned_paths: ["/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts"],
      missing_in_project: [],
      suggested_project_id: "llamactl",
      hint: "pass project_id explicitly or update prompt paths",
    }),
  );
});

test("chain-start rejects prompt_project_mismatch in strict mode for user-initiated dispatches", async () => {
  const services = tempServices({
    agentRegistry: ["planner"],
    projectRegistry: new ProjectRegistry(
      new Map([
        [
          "penumbra",
          { project_id: "penumbra", root_path: "/Volumes/WorkSSD/repos/personal/penumbra" },
        ],
        [
          "llamactl",
          { project_id: "llamactl", root_path: "/Volumes/WorkSSD/repos/personal/llamactl" },
        ],
      ]),
    ),
  });
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = "1";

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
      project_id: "penumbra",
      task_class: "STANDARD",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: "prompt_project_mismatch",
      project_id: "penumbra",
      mentioned_paths: ["/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts"],
      missing_in_project: [],
      suggested_project_id: "llamactl",
      hint: "pass project_id explicitly or update prompt paths",
    },
  });
});

test("chain-start warns and dispatches in strict mode when the mismatch has no suggested project", async () => {
  const services = tempServices({
    agentRegistry: ["planner"],
    projectRegistry: new ProjectRegistry(
      new Map([
        [
          "penumbra",
          { project_id: "penumbra", root_path: "/Volumes/WorkSSD/repos/personal/penumbra" },
        ],
        ["alpha", { project_id: "alpha", root_path: "/tmp/projects/shared" }],
        ["beta", { project_id: "beta", root_path: "/tmp/projects/shared" }],
      ]),
    ),
  });
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = "true";
  const warnSpy = spyOn(services.log, "warn").mockImplementation(noopLog);

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "inspect /tmp/projects/shared/src/foo.ts",
      project_id: "penumbra",
      task_class: "STANDARD",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.routing_warning).toMatchObject({
    code: "prompt_project_mismatch",
    project_id: "penumbra",
    mentioned_paths: ["/tmp/projects/shared/src/foo.ts"],
    missing_in_project: [],
    hint: "pass project_id explicitly or update prompt paths",
  });
  expect(body.routing_warning?.suggested_project_id).toBeUndefined();
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "chain_start.routing_guard.mismatch",
      project_id: "penumbra",
      suggested_project_id: undefined,
    }),
    expect.any(String),
  );
});

test("chain-start allows strict workflow dispatches to cross project prompts", async () => {
  const services = tempServices({
    agentRegistry: ["planner"],
    projectRegistry: new ProjectRegistry(
      new Map([
        [
          "penumbra",
          { project_id: "penumbra", root_path: "/Volumes/WorkSSD/repos/personal/penumbra" },
        ],
        [
          "llamactl",
          { project_id: "llamactl", root_path: "/Volumes/WorkSSD/repos/personal/llamactl" },
        ],
      ]),
    ),
  });
  const previous = process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = "1";
  services.workflowRuns = createWorkflowRunsRegistry({
    uuid: () => "wfrun-1",
    clock: () => new Date("2026-04-26T00:00:00Z"),
    db: services.db,
    storageRoot: "/private/tmp/penumbra-test-storage",
  });
  const workflowRunId = services.workflowRuns.register("cross-project-workflow", "penumbra");
  const warnSpy = spyOn(services.log, "warn").mockImplementation(noopLog);

  try {
    const req = new Request("http://t/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "review diff touching /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
        project_id: "penumbra",
        dispatch_kind: "workflow",
        workflow_run_id: workflowRunId,
        task_class: "STANDARD",
      }),
    });
    const res = await chainsStartRoute(req, services);
    expect(res.status).toBe(200);
    const body = await readJsonBody<ChainResponseBody>(res);
    expect(body).toHaveProperty(
      "routing_warning",
      expect.objectContaining({
        code: "prompt_project_mismatch",
        project_id: "penumbra",
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chain_start.routing_guard.internal_hop_mismatch",
        project_id: "penumbra",
      }),
      expect.any(String),
    );
  } finally {
    if (previous === undefined) {
      delete process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;
    } else {
      process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = previous;
    }
  }
});

test("chain-start rejects spoofed workflow dispatch_kind without valid workflow_run_id", async () => {
  const services = tempServices({
    agentRegistry: ["planner"],
    projectRegistry: new ProjectRegistry(
      new Map([
        [
          "penumbra",
          { project_id: "penumbra", root_path: "/Volumes/WorkSSD/repos/personal/penumbra" },
        ],
        [
          "llamactl",
          { project_id: "llamactl", root_path: "/Volumes/WorkSSD/repos/personal/llamactl" },
        ],
      ]),
    ),
  });
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = "true";
  const warnSpy = spyOn(services.log, "warn").mockImplementation(noopLog);

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
      project_id: "penumbra",
      dispatch_kind: "workflow",
      task_class: "STANDARD",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: "prompt_project_mismatch",
      project_id: "penumbra",
      mentioned_paths: ["/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts"],
      missing_in_project: [],
      suggested_project_id: "llamactl",
      hint: "pass project_id explicitly or update prompt paths",
    },
  });
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "chain_start.routing_guard.workflow_exemption_rejected",
      project_id: "penumbra",
      workflow_run_id_present: false,
    }),
    expect.any(String),
  );
});

test("chain-start rejects forged workflow_run_id", async () => {
  const services = tempServices({
    agentRegistry: ["planner"],
    projectRegistry: new ProjectRegistry(
      new Map([
        [
          "penumbra",
          { project_id: "penumbra", root_path: "/Volumes/WorkSSD/repos/personal/penumbra" },
        ],
        [
          "llamactl",
          { project_id: "llamactl", root_path: "/Volumes/WorkSSD/repos/personal/llamactl" },
        ],
      ]),
    ),
  });
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = "1";
  const warnSpy = spyOn(services.log, "warn").mockImplementation(noopLog);

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
      project_id: "penumbra",
      dispatch_kind: "workflow",
      workflow_run_id: "not-real-uuid",
      task_class: "STANDARD",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(400);
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "chain_start.routing_guard.workflow_exemption_rejected",
      project_id: "penumbra",
      workflow_run_id_present: true,
    }),
    expect.any(String),
  );
});

test("chain-start rejects cross-project workflow_run_id", async () => {
  const services = tempServices({
    agentRegistry: ["planner"],
    projectRegistry: new ProjectRegistry(
      new Map([
        [
          "penumbra",
          { project_id: "penumbra", root_path: "/Volumes/WorkSSD/repos/personal/penumbra" },
        ],
        [
          "llamactl",
          { project_id: "llamactl", root_path: "/Volumes/WorkSSD/repos/personal/llamactl" },
        ],
      ]),
    ),
  });
  services.workflowRuns = createWorkflowRunsRegistry({
    uuid: () => "wfrun-2",
    clock: () => new Date("2026-04-26T00:00:00Z"),
    db: services.db,
    storageRoot: "/private/tmp/penumbra-test-storage",
  });
  const otherWorkflowRunId = services.workflowRuns.register(
    "cross-project-workflow",
    "other-project",
  );
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = "true";

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
      project_id: "penumbra",
      dispatch_kind: "workflow",
      workflow_run_id: otherWorkflowRunId,
      task_class: "STANDARD",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(400);
});

test("chain-start rejects workflow exemption when request lacks project_id", async () => {
  const services = tempServices({
    agentRegistry: ["planner"],
    projectRegistry: new ProjectRegistry(
      new Map([
        [
          "penumbra",
          { project_id: "penumbra", root_path: "/Volumes/WorkSSD/repos/personal/penumbra" },
        ],
        [
          "llamactl",
          { project_id: "llamactl", root_path: "/Volumes/WorkSSD/repos/personal/llamactl" },
        ],
      ]),
    ),
  });
  services.workflowRuns = createWorkflowRunsRegistry({
    uuid: () => "wfrun-3",
    clock: () => new Date("2026-04-26T00:00:00Z"),
    db: services.db,
    storageRoot: "/private/tmp/penumbra-test-storage",
  });
  const workflowRunId = services.workflowRuns.register("cross-project-workflow", "penumbra");
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = "1";
  const warnSpy = spyOn(services.log, "warn").mockImplementation(noopLog);

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
      project_id: null,
      dispatch_kind: "workflow",
      workflow_run_id: workflowRunId,
      task_class: "STANDARD",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(400);
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "chain_start.routing_guard.workflow_exemption_rejected",
      project_id: null,
      workflow_run_id_present: true,
    }),
    expect.any(String),
  );
});

test("chain-start rejects spoofed parent_handoff_id in strict mode when the parent does not resolve", async () => {
  const services = tempServices({
    agentRegistry: ["planner"],
    projectRegistry: new ProjectRegistry(
      new Map([
        [
          "penumbra",
          { project_id: "penumbra", root_path: "/Volumes/WorkSSD/repos/personal/penumbra" },
        ],
        [
          "llamactl",
          { project_id: "llamactl", root_path: "/Volumes/WorkSSD/repos/personal/llamactl" },
        ],
      ]),
    ),
  });
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = "true";
  const warnSpy = spyOn(services.log, "warn").mockImplementation(noopLog);

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
      project_id: "penumbra",
      parent_handoff_id: "forged-nonexistent-id",
      task_class: "STANDARD",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: "prompt_project_mismatch",
      project_id: "penumbra",
      mentioned_paths: ["/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts"],
      missing_in_project: [],
      suggested_project_id: "llamactl",
      hint: "pass project_id explicitly or update prompt paths",
    },
  });
});

test("chain-start rejects strict internal parent_handoff_id hops from another project", async () => {
  const services = tempServices({
    agentRegistry: ["planner"],
    projectRegistry: new ProjectRegistry(
      new Map([
        [
          "penumbra",
          { project_id: "penumbra", root_path: "/Volumes/WorkSSD/repos/personal/penumbra" },
        ],
        [
          "llamactl",
          { project_id: "llamactl", root_path: "/Volumes/WorkSSD/repos/personal/llamactl" },
        ],
      ]),
    ),
  });
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = "true";

  services.db
    .query(
      `INSERT INTO handoffs (
      handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "h-parent",
      "2026-04-26T00:00:00Z",
      "llamactl",
      "conv-parent",
      "user",
      "planner",
      null,
      "parent",
      "open",
    );

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
      project_id: "penumbra",
      parent_handoff_id: "h-parent",
      task_class: "STANDARD",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: "prompt_project_mismatch",
      project_id: "penumbra",
      mentioned_paths: ["/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts"],
      missing_in_project: [],
      suggested_project_id: "llamactl",
      hint: "pass project_id explicitly or update prompt paths",
    },
  });
});

test("chain-start allows strict internal parent_handoff_id hops from the same project", async () => {
  const services = tempServices({
    agentRegistry: ["planner"],
    projectRegistry: new ProjectRegistry(
      new Map([
        [
          "penumbra",
          { project_id: "penumbra", root_path: "/Volumes/WorkSSD/repos/personal/penumbra" },
        ],
        [
          "llamactl",
          { project_id: "llamactl", root_path: "/Volumes/WorkSSD/repos/personal/llamactl" },
        ],
      ]),
    ),
  });
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = "true";
  const warnSpy = spyOn(services.log, "warn").mockImplementation(noopLog);

  services.db
    .query(
      `INSERT INTO handoffs (
      handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "h-parent",
      "2026-04-26T00:00:00Z",
      "penumbra",
      "conv-parent",
      "user",
      "planner",
      null,
      "parent",
      "open",
    );

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
      project_id: "penumbra",
      parent_handoff_id: "h-parent",
      task_class: "STANDARD",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body).toHaveProperty(
    "routing_warning",
    expect.objectContaining({
      code: "prompt_project_mismatch",
      project_id: "penumbra",
    }),
  );
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "chain_start.routing_guard.internal_hop_mismatch",
      project_id: "penumbra",
    }),
    expect.any(String),
  );
});

test("chain-start warns and dispatches for strict long-lived tick hops", async () => {
  const services = tempServices({
    agentRegistry: ["planner"],
    projectRegistry: new ProjectRegistry(
      new Map([
        [
          "penumbra",
          { project_id: "penumbra", root_path: "/Volumes/WorkSSD/repos/personal/penumbra" },
        ],
        [
          "llamactl",
          { project_id: "llamactl", root_path: "/Volumes/WorkSSD/repos/personal/llamactl" },
        ],
      ]),
    ),
  });
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = "1";
  const warnSpy = spyOn(services.log, "warn").mockImplementation(noopLog);

  services.db
    .query(
      `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-42",
      "Home Assistant",
      JSON.stringify({
        version: 1,
        updated_at: 1715385600000,
        pending_goals: [],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      }),
      "Keep home automations healthy",
      1715385600000,
      1715385600000,
    );
  services.db
    .query(
      `INSERT INTO long_lived_ticks (
      id, agent_id, trigger_kind, started_at
    ) VALUES (?, ?, ?, ?)`,
    )
    .run("tick-42", "agent-42", "manual", 1715385600000);

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts",
      project_id: "penumbra",
      dispatch_kind: "long_lived_tick",
      long_lived_agent_id: "agent-42",
      long_lived_tick_id: "tick-42",
      task_class: "STANDARD",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body).toHaveProperty(
    "routing_warning",
    expect.objectContaining({
      code: "prompt_project_mismatch",
      project_id: "penumbra",
    }),
  );
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "chain_start.routing_guard.internal_hop_mismatch",
      project_id: "penumbra",
    }),
    expect.any(String),
  );
});

test("chain-start attaches a routing advisory when the registry cannot be loaded", async () => {
  const services = tempServices({ agentRegistry: ["planner"] });
  services.projectRegistry = {
    list: () => {
      throw new Error("registry unavailable");
    },
  } as ProjectRegistry;

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "touch /tmp/llamactl/src/foo.ts",
      project_id: "penumbra",
      task_class: "STANDARD",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body).toHaveProperty("routing_advisory", {
    code: "project_registry_unavailable",
  });
  expect(body.routing_warning).toBeUndefined();
});

test("POST /chains/start success response parses against ChainStartResponseSchema", async () => {
  const services = tempServices({ agentRegistry: ["planner"] });

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        project_id: "penumbra",
        task_class: "STANDARD",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(() => ChainStartResponseSchema.parse(body)).not.toThrow();
});

test("POST /chains/start fails closed when the response violates ChainStartResponseSchema", async () => {
  const services = tempServices({ agentRegistry: ["planner"] });
  const errorSpy = spyOn(services.log, "error").mockImplementation(noopLog);
  services.recallReader.recall = (): Promise<RecallResult[]> =>
    Promise.resolve([
      {
        id: "m1",
        tier: "t2",
        score: 1,
        fusedScore: 1,
        sources: ["t2"],
        title: "memo",
        body: null as unknown as string,
        project_id: "penumbra",
        source_session_ids: [],
        created_at: "2026-04-26T00:00:00Z",
        ts: "2026-04-26T00:00:00Z",
      },
    ]);

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        project_id: "penumbra",
        task_class: "STANDARD",
      }),
    }),
    services,
  );

  expect(res.status).toBe(500);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error?.code).toBe("response_contract_violation");
  expect(body.error?.message).toBe(
    "chain-start built a response that violates ChainStartResponseSchema",
  );
  expect(body.error?.handoff_id).toBeTruthy();
  expect(body.error?.conversation_id).toBeTruthy();
  const handoff = selectHandoff(services, body.error!.handoff_id!);
  expect(body.error?.handoff_id).toBe(handoff.handoff_id);
  expect(body.error?.conversation_id).toBe(handoff.conversation_id);
  expect(errorSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "chain_start.response_schema_parse_failed",
      handoff_id: handoff.handoff_id,
      conversation_id: handoff.conversation_id,
    }),
    "chain-start response schema parse failed; failing closed",
  );
});

test("chain-start skips the routing guard when no project registry is available", async () => {
  const services = tempServices({ agentRegistry: ["planner"] });

  const req = new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      message: "touch /tmp/llamactl/src/foo.ts",
      project_id: "penumbra",
      task_class: "STANDARD",
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.routing_warning).toBeUndefined();
  expect(body.routing_advisory).toBeUndefined();
});

test("POST /chains/start auto-strips leading @ from initial_agent", async () => {
  const services = tempServices({ agentRegistry: ["planner", "executor"] });
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "@planner", message: "hi" }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.to_agent).toBe("planner");
});

test("POST /chains/start returns 400 invalid_agent if @-stripping leaves an empty agent with no registry loaded", async () => {
  const services = tempServices({ agentRegistry: null });
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "@", message: "hi" }),
    }),
    services,
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: "invalid_agent",
      agent: "",
      hint: "initial_agent must be non-empty after @-prefix/agent:-prefix stripping",
    },
  });
});

test("POST /chains/start returns 400 invalid_agent if @-stripping leaves an empty agent before registry validation", async () => {
  const services = tempServices({ agentRegistry: ["gemini-flash"] });
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "@", message: "hi" }),
    }),
    services,
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: "invalid_agent",
      agent: "",
      hint: "initial_agent must be non-empty after @-prefix/agent:-prefix stripping",
    },
  });
});

test("POST /chains/start strips only the first leading @ before registry validation", async () => {
  const services = tempServices({ agentRegistry: ["gemini-flash"] });
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "@@gemini-flash", message: "hi" }),
    }),
    services,
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: "unknown_agent",
      agent: "@gemini-flash",
      did_you_mean: ["gemini-flash"],
      hint: "use chain.list_agents to enumerate valid agents",
    },
  });
});

test("POST /chains/start returns 503 if no active worker has heartbeated", async () => {
  const services = tempServices();
  services.watchdog.hasActiveWorker = (): boolean => false;

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "planner", message: "hi" }),
    }),
    services,
  );
  expect(res.status).toBe(503);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error?.code).toBe("no_worker_registered");
});

test("POST /chains/start distinguishes stale workers from no registered workers", async () => {
  const services = tempServices();
  services.watchdog.hasActiveWorker = (): boolean => false;
  services.watchdog.getStaleHeartbeatAges = (): {
    worker_id: string;
    last_seen_age_ms: number;
  }[] => [
    { worker_id: "worker-a", last_seen_age_ms: 92_000 },
    { worker_id: "worker-b", last_seen_age_ms: 125_000 },
  ];

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "planner", message: "hi" }),
    }),
    services,
  );
  expect(res.status).toBe(503);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error.code).toBe("worker_heartbeats_stale");
  expect(body.error.workers).toEqual([
    { worker_id: "worker-a", last_seen_age_ms: 92_000 },
    { worker_id: "worker-b", last_seen_age_ms: 125_000 },
  ]);
});

test("POST /chains/start writes user-prompt event + approved handoff and returns ids", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        project_id: "auth-svc",
        max_hops: 5,
        trust_mode: "all",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(typeof body.conversation_id).toBe("string");
  expect(typeof body.handoff_id).toBe("string");

  const t0Row =
    services.db
      .query<Record<string, unknown>, [string]>(`SELECT * FROM t0_events WHERE event_id=?`)
      .get(body.handoff_id ?? "") ?? null;
  // The user-prompt event_id is body.handoff_id's predecessor — we wrote both in one tx.
  // Check counts instead.
  const events = services.db
    .query<{ event_type: string }, []>(`SELECT event_type FROM t0_events`)
    .all();
  expect(events.find((e) => e.event_type === "user-prompt")).toBeDefined();

  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.status).toBe("approved");
  expect(handoff.from_agent).toBe("user");
  expect(handoff.to_agent).toBe("planner");
  expect(handoff.resolved_by).toBe("chain-start");
  expect(handoff.resolved_at).toBeNull();
  expect(handoff.chain_max_hops).toBe(5);
  expect(handoff.chain_trust_mode).toBe("all");
  expect(handoff.conversation_id).toBe(body.conversation_id);
});

test("POST /chains/start respects use_worktree: false", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "planner", message: "hi", use_worktree: false }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.use_worktree).toBe(0);
});

test("POST /chains/start respects use_worktree: true", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "planner", message: "hi", use_worktree: true }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.use_worktree).toBe(1);
});

test("POST /chains/start defaults use_worktree to true if omitted", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "planner", message: "hi" }),
    }),
    services,
  );
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.use_worktree).toBe(1);
});

test("POST /chains/start stores a human-readable branch name when worktree is enabled", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        workload: "implement_substantial",
        task_name: "Full task pool",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  const expectedId = body.handoff_id!.replaceAll(/[^0-9a-f]/gi, "").slice(0, 8);
  expect(handoff.branch_name).toBe(`feat/full-task-pool_${expectedId}`);
});

test("POST /chains/start suffixes branch_name when the project root already has the candidate", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-chain-branch-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });

    const projectRegistry = new ProjectRegistry(
      new Map([["penumbra", { project_id: "penumbra", root_path: repo }]]),
    );
    const requestBody = {
      initial_agent: "planner",
      message: "hi",
      project_id: "penumbra",
      workload: "implement_substantial",
      task_name: "Full task pool",
    };

    // The id suffix makes the candidate name unique by construction, so a
    // plain re-dispatch never collides. To still exercise the collision
    // fallback in manager.ts, probe a fresh (identical, deterministic-uuid)
    // dispatch to learn the exact candidate name, pre-create THAT branch,
    // then dispatch again and assert the `-2` suffix appears.
    const probeServices = tempServices({ projectRegistry });
    const probeRes = await chainsStartRoute(
      new Request("http://x/chains/start", {
        method: "POST",
        body: JSON.stringify(requestBody),
      }),
      probeServices,
    );
    const probeBody = await readJsonBody<ChainResponseBody>(probeRes);
    const candidateName = probeBody.branch_name;
    if (typeof candidateName !== "string") {
      throw new Error("probe dispatch did not return a branch_name");
    }
    execFileSync("git", ["branch", candidateName], { cwd: repo });

    const services = tempServices({ projectRegistry });
    const res = await chainsStartRoute(
      new Request("http://x/chains/start", {
        method: "POST",
        body: JSON.stringify(requestBody),
      }),
      services,
    );

    expect(res.status).toBe(200);
    const body = await readJsonBody<ChainResponseBody>(res);
    const handoff = selectHandoff(services, body.handoff_id!);
    expect(body.branch_name).toBe(`${candidateName}-2`);
    expect(handoff.branch_name).toBe(`${candidateName}-2`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("chain_status reports final branch_name after recordBranchName write-back", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: "conv-final-branch-status",
        initial_agent: "planner",
        message: "hi",
        task_name: "X",
      }),
    }),
    services,
  );
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoffId = body.handoff_id!;
  services.handoffWriter.recordBranchName(handoffId, "feat/x-2");

  const statusRes = handoffsStatusRoute(
    new Request(`http://x/handoffs/${handoffId}/status`),
    handoffId,
    services,
  );
  expect(statusRes.status).toBe(200);
  const statusBody = await readJsonBody<{ branch_name: string | null }>(statusRes);
  expect(statusBody.branch_name).toBe("feat/x-2");
});

test("chain_wait terminal lookup reports final branch_name after recordBranchName write-back", async () => {
  const services = tempServices();
  const startRes = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: "conv-final-branch-wait",
        initial_agent: "planner",
        message: "hi",
        task_name: "X",
      }),
    }),
    services,
  );
  const startBody = await readJsonBody<ChainResponseBody>(startRes);
  const handoffId = startBody.handoff_id!;
  services.handoffWriter.recordBranchName(handoffId, "feat/x-2");
  services.handoffWriter.claimDispatch(handoffId, "worker-final-branch");
  services.handoffWriter.markCompleted(handoffId, { ts: "2026-04-28T00:00:10Z" });

  const latestRes = handoffsLatestRoute(
    new Request("http://x/handoffs/latest?conversation_id=conv-final-branch-wait"),
    services,
  );
  expect(latestRes.status).toBe(200);
  const latestBody = await readJsonBody<{ handoff: { branch_name: string | null } }>(latestRes);
  expect(latestBody.handoff.branch_name).toBe("feat/x-2");
});

test("POST /chains/start derives a human-readable branch name from the message when task_name is omitted", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "Investigate the queue backlog for stuck handoffs",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  const expectedId = body.handoff_id!.replaceAll(/[^0-9a-f]/gi, "").slice(0, 8);
  expect(handoff.branch_name).toBe(`task/investigate-the-queue-backlog-for-stuck_${expectedId}`);
  expect(handoff.branch_name?.startsWith("agent/")).toBe(false);
  // the human-readable part must be real content, not the id repeated
  expect(handoff.branch_name).not.toBe(`task/${expectedId}`);
  expect(handoff.branch_name).not.toBe(`task/${expectedId}_${expectedId}`);
});

test("POST /chains/start does not name the branch after a silent-failure-retry stamp", async () => {
  const services = tempServices();
  const message =
    "[silent-failure-retry] retry_of=11111111-1111-4111-9111-111111111111 prior_agent=codex\n\nInvestigate queue backlog";
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "planner", message }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  const expectedId = body.handoff_id!.replaceAll(/[^0-9a-f]/gi, "").slice(0, 8);
  expect(handoff.branch_name).toBe(`task/investigate-queue-backlog_${expectedId}`);
  expect(handoff.branch_name).not.toContain("silent-failure-retry");
  expect(handoff.branch_name).not.toContain("retry-of");
});

test("POST /chains/start falls back to a literal branch name for a whitespace-only message", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "planner", message: "   " }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  const expectedId = body.handoff_id!.replaceAll(/[^0-9a-f]/gi, "").slice(0, 8);
  expect(handoff.branch_name).toBe(`task/handoff_${expectedId}`);
  expect(handoff.branch_name?.startsWith("agent/")).toBe(false);
  expect(() =>
    execFileSync("git", ["check-ref-format", "--branch", handoff.branch_name!]),
  ).not.toThrow();
});

test("POST /chains/start prefers an explicit task_name over a derived message slug", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "Investigate queue backlog",
        task_name: "Full task pool",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  const expectedId = body.handoff_id!.replaceAll(/[^0-9a-f]/gi, "").slice(0, 8);
  expect(handoff.branch_name).toBe(`task/full-task-pool_${expectedId}`);
});

test("POST /chains/start persists open_pr_on_review: true", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "planner", message: "hi", open_pr_on_review: true }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.open_pr_on_review).toBe(1);
});

test("POST /chains/start defaults open_pr_on_review to null when omitted", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "planner", message: "hi" }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.open_pr_on_review).toBeNull();
});

test("POST /chains/start persists isolated_install: true", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        isolated_install: true,
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.isolated_install).toBe(1);
  expect(ApiHandoffRowSchema.parse(handoff).isolated_install).toBe(true);
});

test("POST /chains/start persists isolated_install: false", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        isolated_install: false,
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.isolated_install).toBe(0);
});

test("POST /chains/start leaves BOUNDARY isolated_install off by default", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        task_class: "BOUNDARY",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.isolated_install).toBeNull();
});

test("POST /chains/start auto-enables BOUNDARY isolated_install only behind env", async () => {
  process.env.PENUMBRA_ISOLATED_INSTALL_AUTO_BOUNDARY = "1";
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        task_class: "BOUNDARY",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.isolated_install).toBe(1);
});

test("POST /chains/start auto-enables STANDARD isolated_install behind fleet-wide env", async () => {
  process.env.PENUMBRA_ISOLATED_INSTALL_AUTO = "1";
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        task_class: "STANDARD",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.isolated_install).toBe(1);
});

test("POST /chains/start preserves explicit isolated_install false behind fleet-wide env", async () => {
  process.env.PENUMBRA_ISOLATED_INSTALL_AUTO = "1";
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        task_class: "STANDARD",
        isolated_install: false,
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.isolated_install).toBe(0);
});

test("POST /chains/start leaves STANDARD isolated_install off with only BOUNDARY env", async () => {
  process.env.PENUMBRA_ISOLATED_INSTALL_AUTO_BOUNDARY = "1";
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        task_class: "STANDARD",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.isolated_install).toBeNull();
});

test("POST /chains/start persists long-lived dispatch identity fields when supplied", async () => {
  const services = tempServices();
  services.db
    .query(
      `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-42",
      "Home Assistant",
      JSON.stringify({
        version: 1,
        updated_at: 1715385600000,
        pending_goals: [],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      }),
      "Keep home automations healthy",
      1715385600000,
      1715385600000,
    );
  services.db
    .query(
      `INSERT INTO long_lived_ticks (
      id, agent_id, trigger_kind, started_at
    ) VALUES (?, ?, ?, ?)`,
    )
    .run("tick-42", "agent-42", "manual", 1715385600000);
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        dispatch_kind: "long_lived_tick",
        long_lived_agent_id: "agent-42",
        long_lived_tick_id: "tick-42",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.dispatch_kind).toBe("long_lived_tick");
  expect(handoff.long_lived_agent_id).toBe("agent-42");
  expect(handoff.long_lived_tick_id).toBe("tick-42");
});

test("POST /chains/start defaults long-lived dispatch identity fields to null when omitted", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.dispatch_kind).toBeNull();
  expect(handoff.long_lived_agent_id).toBeNull();
  expect(handoff.long_lived_tick_id).toBeNull();
});

test("POST /chains/start stamps long-lived tick dispatch prompts before persisting handoff message", async () => {
  const services = tempServices();
  services.db
    .query(
      `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-42",
      "Home Assistant",
      JSON.stringify({
        version: 1,
        updated_at: 1715385600000,
        pending_goals: [{ id: "g-1", text: "Watch kitchen lights" }],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      }),
      "Keep home automations healthy",
      1715385600000,
      1715385600000,
    );
  services.db
    .query(
      `INSERT INTO long_lived_ticks (
      id, agent_id, trigger_kind, trigger_payload_json, started_at
    ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "tick-42",
      "agent-42",
      "event",
      JSON.stringify({ entity_id: "light.kitchen" }),
      1715385600000,
    );

  const rawMessage = "reactor placeholder";
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: rawMessage,
        dispatch_kind: "long_lived_tick",
        long_lived_agent_id: "agent-42",
        long_lived_tick_id: "tick-42",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = services.db
    .query<{ message: string }, [string]>(`SELECT message FROM handoffs WHERE handoff_id=?`)
    .get(body.handoff_id ?? "");
  expect(handoff?.message).not.toBe(rawMessage);
  expect(handoff?.message).toContain("Tick id: tick-42");

  const promptEvent = services.db
    .query<T0PayloadRow, [string]>(
      `SELECT payload_json FROM t0_events
     WHERE session_id=? AND event_type='user-prompt'
     ORDER BY ts DESC
     LIMIT 1`,
    )
    .get(body.conversation_id ?? "");
  const rawPayload = promptEvent?.payload_json ?? null;
  const payloadJson =
    typeof rawPayload === "string" ? (JSON.parse(rawPayload) as unknown) : rawPayload;
  expect(payloadJson).toEqual({ prompt: rawMessage });
});

test("POST /chains/start returns unknown_long_lived_agent when long-lived dispatch identity cannot be resolved", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "reactor placeholder",
        dispatch_kind: "long_lived_tick",
        long_lived_agent_id: "missing-agent",
        long_lived_tick_id: "tick-42",
      }),
    }),
    services,
  );
  expect(res.status).toBe(400);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error.code).toBe("unknown_long_lived_agent");
});

test("POST /chains/start rejects mismatched long-lived agent/tick identity", async () => {
  const services = tempServices();
  services.db
    .query(
      `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-a",
      "Agent A",
      JSON.stringify({
        version: 1,
        updated_at: 1715385600000,
        pending_goals: [],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      }),
      "A brief",
      1715385600000,
      1715385600000,
    );
  services.db
    .query(
      `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-b",
      "Agent B",
      JSON.stringify({
        version: 1,
        updated_at: 1715385600000,
        pending_goals: [],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      }),
      "B brief",
      1715385600000,
      1715385600000,
    );
  services.db
    .query(
      `INSERT INTO long_lived_ticks (
      id, agent_id, trigger_kind, started_at
    ) VALUES (?, ?, ?, ?)`,
    )
    .run("tick-a", "agent-a", "manual", 1715385600000);

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "reactor placeholder",
        dispatch_kind: "long_lived_tick",
        long_lived_agent_id: "agent-b",
        long_lived_tick_id: "tick-a",
      }),
    }),
    services,
  );

  expect(res.status).toBe(400);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error.code).toBe("cross_identity_long_lived");
  expect(body.error.long_lived_agent_id).toBe("agent-b");
  expect(body.error.long_lived_tick_id).toBe("tick-a");
});

test("POST /chains/start honors caller-supplied conversation_id", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        conversation_id: "conv-mine",
      }),
    }),
    services,
  );
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.conversation_id).toBe("conv-mine");
});

test("POST /chains/start returns 400 for invalid body", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ message: "hi" }),
    }),
    services,
  );
  expect(res.status).toBe(400);
});

test("chainStartFromInput returns same validation_error payload as POST /chains/start for missing initial_agent", async () => {
  const services = tempServices();
  const httpRes = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ message: "hi" }),
    }),
    services,
  );
  const internalRes = await chainStartFromInput({ message: "hi" }, services);

  expect(internalRes.status).toBe(httpRes.status);
  expect(await internalRes.json()).toEqual(await httpRes.json());
});

test("POST /chains/start still returns schema validation_error for empty initial_agent input", async () => {
  const services = tempServices({ agentRegistry: ["gemini-flash"] });
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "", message: "hi" }),
    }),
    services,
  );
  expect(res.status).toBe(400);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error.code).toBe("validation_error");
  expect(body.error.field_errors).toContainEqual({
    path: ["initial_agent"],
    message: "Too small: expected string to have >=1 characters",
  });
});

test("POST /chains/start emits exactly one handoff-events event for the new approved row", async () => {
  const services = tempServices();
  const seen: { status: string }[] = [];
  services.handoffEvents.subscribe((row) => {
    seen.push({ status: row.status });
  });

  await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "planner", message: "hi" }),
    }),
    services,
  );

  expect(seen.length).toBe(1);
  expect(seen[0].status).toBe("approved");
});

test("GET /chains/history returns chain-terminated events for a conversation", async () => {
  const services = tempServices();
  const ts = "2026-04-26T12:00:00Z";
  services.t0Writer.write({
    event_id: "ev1",
    ts,
    ingest_ts: ts,
    source: "agentchat",
    source_detail: null,
    project_id: null,
    user_id: "u1",
    machine_id: "m1",
    session_id: "c1",
    event_type: "chain-terminated",
    lane: "local",
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: { reason: "max_hops reached", hop_count: 5, terminal_handoff_id: "h1" },
    payload_summary: "terminated",
  });

  const res = chainsHistoryRoute(
    new Request("http://x/chains/history?conversation_id=c1"),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainHistoryBody>(res);
  expect(body.history.length).toBe(1);
  expect(body.history[0]?.reason).toBe("max_hops reached");
  expect(body.history[0]?.hop_count).toBe(5);
  expect(body.history[0]?.conversation_id).toBe("c1");
});

test("GET /chains/history returns 400 if conversation_id is missing", () => {
  const services = tempServices();
  const res = chainsHistoryRoute(new Request("http://x/chains/history"), services);
  expect(res.status).toBe(400);
});

test("GET /chains/agents returns [] when no registry is loaded", async () => {
  const services = tempServices({ agentRegistry: null });
  const res = chainsListAgentsRoute(new Request("http://x/chains/agents"), services);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ agents: [] });
});

test("GET /chains/agents preserves registry order and shape", async () => {
  const services = tempServices({ agentRegistry: ["planner", "executor", "reviewer"] });
  const res = chainsListAgentsRoute(new Request("http://x/chains/agents"), services);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    agents: [{ name: "planner" }, { name: "executor" }, { name: "reviewer" }],
  });
});

test("GET /chains/agents adds each probed seat's local health state", async () => {
  type SeatHealthRow = { state: string; checkedAtMs: number; httpStatus?: number };
  const services = tempServices({ agentRegistry: ["a", "b", "c"] });
  const records = new Map<string, SeatHealthRow>([
    ["a", { state: "healthy", checkedAtMs: 1_000 }],
    ["b", { state: "unauthorized", checkedAtMs: 2_000, httpStatus: 401 }],
  ]);
  services.localSeatHealth = {
    getUnhealthyAgents: (): Set<string> => new Set(["b"]),
    getSeatHealth: (name: string): SeatHealthRow | undefined => records.get(name),
  };
  const res = chainsListAgentsRoute(new Request("http://x/chains/agents"), services);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    agents: [
      { name: "a", health: { state: "healthy", checked_at: "1970-01-01T00:00:01.000Z" } },
      {
        name: "b",
        health: {
          state: "unauthorized",
          checked_at: "1970-01-01T00:00:02.000Z",
          http_status: 401,
          routable: false,
        },
      },
      { name: "c" },
    ],
  });
});

test("GET /chains/agents keeps plain rows when the seat health service has no getSeatHealth", async () => {
  const services = tempServices({ agentRegistry: ["a", "b"] });
  services.localSeatHealth = {
    getUnhealthyAgents: (): Set<string> => new Set(["a"]),
  };
  const res = chainsListAgentsRoute(new Request("http://x/chains/agents"), services);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ agents: [{ name: "a" }, { name: "b" }] });
});

test("GET /chains/agents marks seats that routing excludes as not routable (#360)", async () => {
  type SeatHealthRow = { state: string; checkedAtMs: number; httpStatus?: number };
  const services = tempServices({ agentRegistry: ["a", "b", "c", "d"] });
  const records = new Map<string, SeatHealthRow>([
    ["a", { state: "healthy", checkedAtMs: 1_000 }],
    ["b", { state: "healthy", checkedAtMs: 2_000 }],
  ]);
  services.localSeatHealth = {
    getUnhealthyAgents: (): Set<string> => new Set(["a", "c"]),
    getSeatHealth: (name: string): SeatHealthRow | undefined => records.get(name),
  };
  const res = chainsListAgentsRoute(new Request("http://x/chains/agents"), services);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    agents: [
      {
        name: "a",
        health: { state: "healthy", checked_at: "1970-01-01T00:00:01.000Z", routable: false },
      },
      { name: "b", health: { state: "healthy", checked_at: "1970-01-01T00:00:02.000Z" } },
      { name: "c", health: { state: "unknown", routable: false } },
      { name: "d" },
    ],
  });
});

test("GET /chains/agents marks a healthy probe older than the routing TTL as not routable (#360)", async () => {
  let nowMs = 1_000;
  const seatHealth = createLocalSeatHealthService({
    agents: (): LocalSeatHealthAgent[] => [
      {
        name: "local-a",
        adapter: "openai-compat-http",
        options: { baseUrl: "http://127.0.0.1:7944", model: "m1" },
      },
    ],
    now: (): number => nowMs,
    fetch: (): Promise<Response> =>
      Promise.resolve(new Response(JSON.stringify({ data: [{ id: "m1" }] }))),
  });
  await seatHealth.refresh();
  const services = tempServices({ agentRegistry: ["local-a"] });
  services.localSeatHealth = seatHealth;

  nowMs = 1_000 + LOCAL_SEAT_HEALTH_TTL_MS - 1;
  const fresh = chainsListAgentsRoute(new Request("http://x/chains/agents"), services);
  expect(await fresh.json()).toEqual({
    agents: [
      { name: "local-a", health: { state: "healthy", checked_at: "1970-01-01T00:00:01.000Z" } },
    ],
  });

  nowMs = 1_000 + LOCAL_SEAT_HEALTH_TTL_MS + 1;
  const stale = chainsListAgentsRoute(new Request("http://x/chains/agents"), services);
  expect(await stale.json()).toEqual({
    agents: [
      {
        name: "local-a",
        health: { state: "healthy", checked_at: "1970-01-01T00:00:01.000Z", routable: false },
      },
    ],
  });
});

test("GET /chains/responses returns agent responses for a conversation", async () => {
  const services = tempServices();
  writeAgentResponse(services, {
    event_id: "ev1",
    ts: "2026-04-26T12:00:00Z",
    source_detail: "planner",
    user_id: "planner",
    session_id: "c1",
    payload_json: { response: "hello from planner" },
  });
  writeAgentResponse(services, {
    event_id: "ev2",
    ts: "2026-04-26T12:05:00Z",
    source_detail: "executor",
    user_id: "executor",
    session_id: "c1",
    payload_json: { response: "hello from executor" },
  });

  const resFinal = chainsResponsesRoute(
    new Request("http://x/chains/responses?conversation_id=c1"),
    services,
  );
  expect(resFinal.status).toBe(200);
  const bodyFinal = await readJsonBody<ChainResponseListBody>(resFinal);
  expect(bodyFinal.responses.length).toBe(1);
  expect(bodyFinal.responses[0]?.agent).toBe("executor");
  expect(bodyFinal.responses[0]?.text).toBe("hello from executor");

  const resAll = chainsResponsesRoute(
    new Request("http://x/chains/responses?conversation_id=c1&which=all"),
    services,
  );
  const bodyAll = await readJsonBody<ChainResponseListBody>(resAll);
  expect(bodyAll.responses.length).toBe(2);
  expect(bodyAll.responses[0]?.agent).toBe("planner");
  expect(bodyAll.responses[0]?.text).toBe("hello from planner");
  expect(bodyAll.responses[1]?.agent).toBe("executor");
  expect(bodyAll.responses[1]?.text).toBe("hello from executor");
});

test("GET /chains/responses can scope final response to one handoff_id", async () => {
  const services = tempServices();
  services.db
    .query(
      `INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "h-first",
      "2026-04-26T12:00:00Z",
      null,
      "c-hop",
      "user",
      "planner",
      null,
      "first",
      "completed",
    );
  services.db
    .query(
      `INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "h-second",
      "2026-04-26T12:05:00Z",
      null,
      "c-hop",
      "planner",
      "executor",
      null,
      "second",
      "completed",
    );
  writeAgentResponse(services, {
    event_id: "ev-hop-1",
    ts: "2026-04-26T12:01:00Z",
    user_id: "planner",
    session_id: "c-hop",
    payload_json: { response: "first hop", handoff_id: "h-first" },
  });
  writeAgentResponse(services, {
    event_id: "ev-hop-2",
    ts: "2026-04-26T12:06:00Z",
    user_id: "executor",
    session_id: "c-hop",
    payload_json: { response: "second hop", handoff_id: "h-second" },
  });

  const latestRes = chainsResponsesRoute(
    new Request("http://x/chains/responses?conversation_id=c-hop&which=final"),
    services,
  );
  expect(latestRes.status).toBe(200);
  const latestBody = await readJsonBody<ChainResponseListBody>(latestRes);
  expect(latestBody.responses).toEqual([
    {
      agent: "executor",
      text: "second hop",
      ts: "2026-04-26T12:06:00Z",
      handoff_id: "h-second",
    },
  ]);

  const scopedRes = chainsResponsesRoute(
    new Request("http://x/chains/responses?conversation_id=c-hop&which=final&handoff_id=h-first"),
    services,
  );
  expect(scopedRes.status).toBe(200);
  const scopedBody = await readJsonBody<ChainResponseListBody>(scopedRes);
  expect(scopedBody.responses).toEqual([
    {
      agent: "planner",
      text: "first hop",
      ts: "2026-04-26T12:01:00Z",
      handoff_id: "h-first",
    },
  ]);
});

test("GET /chains/responses returns empty scoped responses for unstamped sibling rows", async () => {
  const services = tempServices();
  writeAgentResponse(services, {
    event_id: "ev-unstamped-sibling",
    ts: "2026-04-26T12:01:00Z",
    user_id: "planner",
    session_id: "c-hop",
    payload_json: { response: "unstamped sibling" },
  });

  const res = chainsResponsesRoute(
    new Request("http://x/chains/responses?conversation_id=c-hop&which=all&handoff_id=h-first"),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseListBody>(res);
  expect(body.responses).toEqual([]);
});

test("GET /chains/responses falls back to user_id for production agent-response rows", async () => {
  const services = tempServices();
  writeAgentResponse(services, {
    event_id: "ev1",
    ts: "2026-04-26T12:00:00Z",
    source_detail: null,
    source: "agentchat",
    user_id: "planner",
    session_id: "c1",
    payload_json: { response: "hello from planner" },
  });

  const res = chainsResponsesRoute(
    new Request("http://x/chains/responses?conversation_id=c1"),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.responses).toEqual([
    {
      agent: "planner",
      text: "hello from planner",
      ts: "2026-04-26T12:00:00Z",
      handoff_id: null,
    },
  ]);
});

test("GET /chains/responses prefers source_detail seat name over normalized machine user_id", async () => {
  const services = tempServices();
  writeAgentResponse(services, {
    event_id: "ev1",
    ts: "2026-04-26T12:00:00Z",
    source_detail: "openai-codex-deep-acp",
    source: "agentchat",
    user_id: "473ff22b-fa37-4707-b75c-9ecac18142aa",
    session_id: "c1",
    payload_json: { response: "hello from codex" },
  });

  const res = chainsResponsesRoute(
    new Request("http://x/chains/responses?conversation_id=c1"),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.responses).toEqual([
    {
      agent: "openai-codex-deep-acp",
      text: "hello from codex",
      ts: "2026-04-26T12:00:00Z",
      handoff_id: null,
    },
  ]);
});

test("GET /chains/responses returns 404 only for unknown conversations and preserves empty known conversations", async () => {
  const services = tempServices();
  writeConversationMarker(services, "known-empty");

  const knownRes = chainsResponsesRoute(
    new Request("http://x/chains/responses?conversation_id=known-empty&which=all"),
    services,
  );
  expect(knownRes.status).toBe(200);
  const knownBody = await knownRes.json();
  expect(knownBody).toEqual({ responses: [] });

  const missingRes = chainsResponsesRoute(
    new Request("http://x/chains/responses?conversation_id=missing-conv&which=all"),
    services,
  );
  expect(missingRes.status).toBe(404);
  const missingBody = await missingRes.json();
  expect(missingBody).toEqual({
    error: { code: "not_found", message: "no chain events found for conversation" },
  });
});

test("GET /chains/responses returns 400 for empty handoff_id", () => {
  const services = tempServices();
  const res = chainsResponsesRoute(
    new Request("http://x/chains/responses?conversation_id=c1&handoff_id="),
    services,
  );
  expect(res.status).toBe(400);
});

test("GET /chains/responses decodes multiline responses and surfaces error payloads", async () => {
  const services = tempServices();
  writeAgentResponse(services, {
    event_id: "ev1",
    ts: "2026-04-26T12:00:00Z",
    user_id: "planner",
    session_id: "c1",
    payload_json: { response: "line1\nline2" },
  });
  writeAgentResponse(services, {
    event_id: "ev2",
    ts: "2026-04-26T12:01:00Z",
    user_id: "planner",
    session_id: "c1",
    payload_json: { error: "adapter crashed" },
  });

  const res = chainsResponsesRoute(
    new Request("http://x/chains/responses?conversation_id=c1&which=all"),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.responses).toEqual([
    {
      agent: "planner",
      text: "line1\nline2",
      ts: "2026-04-26T12:00:00Z",
      handoff_id: null,
    },
    {
      agent: "planner",
      text: "",
      error: { message: "adapter crashed" },
      ts: "2026-04-26T12:01:00Z",
      handoff_id: null,
    },
  ]);
});

test("GET /chains/responses handles malformed payload_json rows without 500ing", async () => {
  const services = tempServices();
  services.db.run(`
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id, session_id,
      event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms, request_id,
      payload_json, payload_summary
    ) VALUES (
      'ev-bad', '2026-04-26T12:00:00Z', '2026-04-26T12:00:00Z', 'agentchat', NULL, NULL, 'planner', 'm1', 'c1',
      'agent-response', 'local', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      '{bad json', 'response'
    );
  `);

  const res = chainsResponsesRoute(
    new Request("http://x/chains/responses?conversation_id=c1"),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.responses).toEqual([
    {
      agent: "planner",
      text: "",
      error: { message: "malformed payload_json" },
      ts: "2026-04-26T12:00:00Z",
      handoff_id: null,
    },
  ]);
});

test("GET /chains/responses orders same-ts rows deterministically by ingest_ts then event_id", async () => {
  const services = tempServices();
  writeAgentResponse(services, {
    event_id: "ev-b",
    ts: "2026-04-26T12:00:00Z",
    ingest_ts: "2026-04-26T12:00:02Z",
    user_id: "executor",
    session_id: "c1",
    payload_json: { response: "second" },
  });
  writeAgentResponse(services, {
    event_id: "ev-a",
    ts: "2026-04-26T12:00:00Z",
    ingest_ts: "2026-04-26T12:00:01Z",
    user_id: "planner",
    session_id: "c1",
    payload_json: { response: "first" },
  });
  writeAgentResponse(services, {
    event_id: "ev-c",
    ts: "2026-04-26T12:00:00Z",
    ingest_ts: "2026-04-26T12:00:02Z",
    user_id: "reviewer",
    session_id: "c1",
    payload_json: { response: "third" },
  });

  const resFinal = chainsResponsesRoute(
    new Request("http://x/chains/responses?conversation_id=c1"),
    services,
  );
  expect(resFinal.status).toBe(200);
  const bodyFinal = await resFinal.json();
  expect(bodyFinal.responses).toEqual([
    {
      agent: "reviewer",
      text: "third",
      ts: "2026-04-26T12:00:00Z",
      handoff_id: null,
    },
  ]);

  const resAll = chainsResponsesRoute(
    new Request("http://x/chains/responses?conversation_id=c1&which=all"),
    services,
  );
  expect(resAll.status).toBe(200);
  const bodyAll = await readJsonBody<ChainResponseListBody>(resAll);
  expect(bodyAll.responses.map((response) => response.agent)).toEqual([
    "planner",
    "executor",
    "reviewer",
  ]);
});

test("GET /chains/responses returns 400 if conversation_id is missing", () => {
  const services = tempServices();
  const res = chainsResponsesRoute(new Request("http://x/chains/responses"), services);
  expect(res.status).toBe(400);
});

test("GET /chains/messages returns all events for a conversation chronologically", async () => {
  const services = tempServices();
  services.db.run(`
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id, session_id,
      event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms, request_id,
      payload_json, payload_summary
    ) VALUES 
    ('ev1', '2026-04-26T12:00:00Z', '2026-04-26T12:00:00Z', 'agentchat', NULL, NULL, 'u1', 'm1', 'c1', 'user-prompt', 'local', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{"prompt":"hi"}', 'hi'),
    ('ev2', '2026-04-26T12:01:00Z', '2026-04-26T12:01:00Z', 'agentchat', NULL, NULL, 'u1', 'm1', 'c1', 'agent-response', 'local', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{"response":"hello"}', 'hello')
  `);

  const { chainsMessagesRoute } = await import("@src/routes/chains.js");
  const res = chainsMessagesRoute(
    new Request("http://x/chains/messages?conversation_id=c1"),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainMessagesBody>(res);
  expect(body.events.length).toBe(2);
  expect(body.events[0].event_type).toBe("user-prompt");
  expect(body.events[0].payload).toEqual({ prompt: "hi" });
  expect(body.events[1].event_type).toBe("agent-response");
  expect(body.events[1].payload).toEqual({ response: "hello" });
});

test("GET /chains/messages filters by types array", async () => {
  const services = tempServices();
  services.db.run(`
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id, session_id,
      event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms, request_id,
      payload_json, payload_summary
    ) VALUES 
    ('ev1', '2026-04-26T12:00:00Z', '2026-04-26T12:00:00Z', 'agentchat', NULL, NULL, 'u1', 'm1', 'c1', 'user-prompt', 'local', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{"prompt":"hi"}', 'hi'),
    ('ev2', '2026-04-26T12:01:00Z', '2026-04-26T12:01:00Z', 'agentchat', NULL, NULL, 'u1', 'm1', 'c1', 'agent-response', 'local', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{"response":"hello"}', 'hello')
  `);

  const { chainsMessagesRoute } = await import("@src/routes/chains.js");
  const res = chainsMessagesRoute(
    new Request("http://x/chains/messages?conversation_id=c1&types=agent-response"),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainMessagesBody>(res);
  expect(body.events.length).toBe(1);
  expect(body.events[0].event_type).toBe("agent-response");
});

test("GET /chains/messages parses malformed JSON safely as null", async () => {
  const services = tempServices();
  services.db.run(`
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id, session_id,
      event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms, request_id,
      payload_json, payload_summary
    ) VALUES 
    ('ev1', '2026-04-26T12:00:00Z', '2026-04-26T12:00:00Z', 'agentchat', NULL, NULL, 'u1', 'm1', 'c1', 'user-prompt', 'local', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{bad', 'hi')
  `);

  const { chainsMessagesRoute } = await import("@src/routes/chains.js");
  const res = chainsMessagesRoute(
    new Request("http://x/chains/messages?conversation_id=c1"),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainMessagesBody>(res);
  expect(body.events.length).toBe(1);
  expect(body.events[0].payload).toBeNull();
});

test("GET /chains/messages returns 400 if conversation_id is missing", async () => {
  const services = tempServices();
  const { chainsMessagesRoute } = await import("@src/routes/chains.js");
  const res = chainsMessagesRoute(new Request("http://x/chains/messages"), services);
  expect(res.status).toBe(400);
});

test("GET /chains/messages returns empty events array for unknown conversation_id", async () => {
  const services = tempServices();
  const { chainsMessagesRoute } = await import("@src/routes/chains.js");
  const res = chainsMessagesRoute(
    new Request("http://x/chains/messages?conversation_id=unknown-id"),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainMessagesBody>(res);
  expect(body.events.length).toBe(0);
});

function executorRouting(): AgentRoutingConfig {
  return {
    agents: [
      { name: "gemini", roles: ["executor"] },
      { name: "codex-mini", roles: ["executor"] },
    ],
    default_roles: { executor: "gemini" },
  };
}

function seedExecutorLedger(services: Services): void {
  seedPerformance(services, {
    performance_id: "p-good",
    handoff_id: "h-good",
    agent_name: "codex-mini",
    task_type: "implement_substantial",
    outcome: "merged",
    rounds: 1,
    smoke_pass: "y",
  });
  seedPerformance(services, {
    performance_id: "p-bad",
    handoff_id: "h-bad",
    agent_name: "gemini",
    task_type: "implement_substantial",
    outcome: "failed",
    rounds: 4,
    smoke_pass: "n",
  });
}

function excludeProvider(services: Services, provider: string): void {
  setRoutingBias(services.db, {
    scope: "provider",
    value: provider,
    mode: "exclude",
    weight: null,
    reason: "test",
    ttl_seconds: 3600,
    now: services.clock(),
  });
}

test("chain_start with taskRouterConfig mode:'off' is byte-identical to the pre-router baseline and writes no routing_decisions row", async () => {
  const services = tempServices({
    agentRegistry: ["gemini", "codex-mini"],
    agentRouting: executorRouting(),
  });
  seedExecutorLedger(services);
  services.taskRouterConfig = TaskRouterConfigSchema.parse({ mode: "off" });
  services.modelAliasMap = {};

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "executor",
        task_type: "implement_substantial",
        message: "implement the change",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body).toEqual(PRE_ROUTER_ROLE_RESPONSE_FIXTURE);

  const decisions = readRoutingDecisions(services.db, { handoffId: body.handoff_id! });
  expect(decisions).toHaveLength(0);
});

for (const mode of ["off", "recommend", "shadow"] as const) {
  test(`chain_start with taskRouterConfig mode:'${mode}' returns 4xx when routing biases exclude every role candidate`, async () => {
    const services = tempServices({
      agentRegistry: ["gemini", "codex-mini"],
      agentRouting: {
        agents: [
          {
            name: "gemini",
            roles: ["executor"],
            pricing_mode: "subscription",
            subscription_provider: "google",
          },
          {
            name: "codex-mini",
            roles: ["executor"],
            pricing_mode: "subscription",
            subscription_provider: "openai",
          },
        ],
        default_roles: { executor: "gemini" },
      },
    });
    services.taskRouterConfig = TaskRouterConfigSchema.parse({ mode });
    services.modelAliasMap = {};
    excludeProvider(services, "google");
    excludeProvider(services, "openai");

    const res = await chainsStartRoute(
      new Request("http://x/chains/start", {
        method: "POST",
        body: JSON.stringify({
          initial_agent: "executor",
          task_type: "implement_substantial",
          message: "implement the change",
        }),
      }),
      services,
    );

    expect(res.status).toBe(422);
    const body = await readJsonBody<ChainResponseBody>(res);
    expect(body.error?.code).toBe("routing_bias_exhausted");

    const handoffRows = services.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM handoffs")
      .get();
    expect(handoffRows?.n ?? 0).toBe(0);
  });
}

test("handoffs create chain-hop returns 4xx without persisting when routing biases exclude every role candidate", async () => {
  const services = tempServices({
    agentRegistry: ["gemini", "codex-mini"],
    agentRouting: {
      agents: [
        {
          name: "gemini",
          roles: ["executor"],
          pricing_mode: "subscription",
          subscription_provider: "google",
        },
        {
          name: "codex-mini",
          roles: ["executor"],
          pricing_mode: "subscription",
          subscription_provider: "openai",
        },
      ],
      default_roles: { executor: "gemini" },
    },
  });
  excludeProvider(services, "google");
  excludeProvider(services, "openai");

  const res = await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "maestro",
        to: "gemini",
        to_role: "executor",
        message: "continue the chain",
        conversation_id: "conv-hop-bias",
        triggered_by_event_id: "event-hop-bias",
        chain_task_type: "implement_substantial",
      }),
    }),
    services,
  );

  expect(res.status).toBe(422);
  const body = await readJsonBody<HandoffCreateErrorBody>(res);
  expect(body.error.code).toBe("routing_bias_exhausted");

  const handoffRows = services.db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM handoffs")
    .get();
  expect(handoffRows?.n ?? 0).toBe(0);
});

test("chain_start with taskRouterConfig mode:'shadow' keeps the legacy route and records an unapplied decision row", async () => {
  const services = tempServices({
    agentRegistry: ["gemini", "codex-mini"],
    agentRouting: executorRouting(),
  });
  seedExecutorLedger(services);
  services.taskRouterConfig = TaskRouterConfigSchema.parse({ mode: "shadow" });
  services.modelAliasMap = {};

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "executor",
        task_type: "implement_substantial",
        message: "implement the change",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  // Same routed agent as the mode:'off' baseline -- shadow mode must never
  // change the live route.
  expect(body.routed_agent).toBe("codex-mini");

  const decisions = readRoutingDecisions(services.db, { handoffId: body.handoff_id! });
  expect(decisions).toHaveLength(1);
  expect(decisions[0].mode).toBe("shadow");
  expect(decisions[0].applied).toBe(false);
  expect(decisions[0].handoffId).toBe(body.handoff_id);
});

test("chain_start with taskRouterConfig mode:'auto' applies the router's own selection and records applied:true", async () => {
  const services = tempServices({
    agentRegistry: ["gemini", "codex-mini"],
    agentRouting: executorRouting(),
  });
  seedExecutorLedger(services);
  services.taskRouterConfig = TaskRouterConfigSchema.parse({ mode: "auto" });
  services.modelAliasMap = {};

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "executor",
        task_type: "implement_substantial",
        message: "implement the change",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.requested_agent).toBe("executor");
  expect(body.routed_agent).toBe("codex-mini");
  expect(body.routing_resolution_reason).toBe("role_route");

  const decisions = readRoutingDecisions(services.db, { handoffId: body.handoff_id! });
  expect(decisions).toHaveLength(1);
  expect(decisions[0].mode).toBe("auto");
  expect(decisions[0].applied).toBe(true);
  expect(decisions[0].selectedAgent).toBe("codex-mini");
});

test("chain_start auto routing fails closed when provider-scoped biases exist but provider facts are unavailable", async () => {
  const services = tempServices({
    agentRegistry: ["anthropic-seat"],
    agentRouting: {
      agents: [{ name: "anthropic-seat", roles: ["reviewer"] }],
      default_roles: { reviewer: "anthropic-seat" },
      role_exploration_policy: "ranked-first",
    },
  });
  seedPerformance(services, {
    performance_id: "p-unknown-provider-facts",
    handoff_id: "h-unknown-provider-facts",
    agent_name: "anthropic-seat",
    task_type: "review_adversarial",
    outcome: "merged",
  });
  services.taskRouterConfig = TaskRouterConfigSchema.parse({ mode: "auto" });
  services.modelAliasMap = {};
  excludeProvider(services, "anthropic");

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "reviewer",
        task_type: "review_adversarial",
        message: "review this change",
      }),
    }),
    services,
  );

  expect(res.status).toBe(422);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error?.code).toBe("router_hard_constraint_exhausted");
  expect(body.error?.reasons).toEqual([
    {
      route_id: "unknown:anthropic-seat",
      reasons: ["router_facts_unavailable"],
    },
  ]);
  expect(
    services.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM handoffs").get()?.c ?? 0,
  ).toBe(0);
  const decisions = readRoutingDecisions(services.db, { handoffId: null });
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({
    handoffId: null,
    mode: "auto",
    role: "reviewer",
    selectedAgent: null,
    applied: false,
  });
  expect(decisions[0]?.alternatives).toEqual([
    {
      routeId: "unknown:anthropic-seat",
      excluded: true,
      reasons: ["router_facts_unavailable"],
    },
  ]);
});

test("chain_start auto fallback does not re-admit a bias-excluded strict role holder", async () => {
  const services = tempServices({
    agentRegistry: ["biased-first", "pressured-second"],
    agentRouting: {
      agents: [
        {
          name: "biased-first",
          roles: ["executor"],
          pricing_mode: "subscription",
          subscription_provider: "openai",
        },
        {
          name: "pressured-second",
          roles: ["executor"],
          pricing_mode: "subscription",
          subscription_provider: "anthropic",
        },
      ],
      default_roles: { executor: "biased-first" },
      role_exploration_policy: "ranked-first",
    },
  });
  for (const agent of ["biased-first", "pressured-second"] as const) {
    seedPerformance(services, {
      performance_id: `p-fallback-${agent}`,
      handoff_id: `h-fallback-${agent}`,
      agent_name: agent,
      task_type: "implement_small",
      outcome: "merged",
    });
  }
  services.taskRouterConfig = TaskRouterConfigSchema.parse({ mode: "auto" });
  services.modelAliasMap = {};
  services.aaSnapshotStore = {
    ...services.aaSnapshotStore,
    readSync: (): never => {
      throw new Error("snapshot unavailable");
    },
  };
  excludeProvider(services, "openai");
  seedSubscriptionPressure(services, "anthropic", 95);

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "executor",
        task_type: "implement_small",
        message: "implement the change",
      }),
    }),
    services,
  );

  expect(res.status).toBe(422);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error?.code).toBe("role_route_unavailable");
  expect(
    services.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM handoffs").get()?.c ?? 0,
  ).toBe(0);
  const decisions = readRoutingDecisions(services.db, { limit: 10 });
  expect(decisions).toHaveLength(0);
});

test("chain_start auto routing explores a known role with zero live strict holders", async () => {
  const services = tempServices({
    agentRegistry: ["planner-seat"],
    agentRouting: {
      agents: [
        { name: "offline-executor", roles: ["executor"] },
        { name: "planner-seat", roles: ["planner"] },
      ],
      default_roles: {},
    },
  });
  seedPerformance(services, {
    performance_id: "p-zero-holder-exploration",
    handoff_id: "h-zero-holder-exploration",
    agent_name: "planner-seat",
    task_type: "implement_small",
    outcome: "merged",
  });
  services.taskRouterConfig = TaskRouterConfigSchema.parse({ mode: "auto" });
  services.modelAliasMap = {};

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "executor",
        task_type: "implement_small",
        message: "implement the change",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body).toMatchObject({
    requested_agent: "executor",
    routed_agent: "planner-seat",
    routed_role: "executor",
    routing_resolution_reason: "role_route",
  });
  const decisions = readRoutingDecisions(services.db, { handoffId: body.handoff_id! });
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({
    mode: "auto",
    selectedAgent: "planner-seat",
    applied: true,
  });
});

for (const mode of ["off", "recommend", "shadow"] as const) {
  test(`chain_start mode:'${mode}' preserves strict role holders for a known zero-holder role`, async () => {
    const services = tempServices({
      agentRegistry: ["planner-seat"],
      agentRouting: {
        agents: [
          { name: "offline-executor", roles: ["executor"] },
          { name: "planner-seat", roles: ["planner"] },
        ],
        default_roles: {},
      },
    });
    services.taskRouterConfig = TaskRouterConfigSchema.parse({ mode });

    const res = await chainsStartRoute(
      new Request("http://x/chains/start", {
        method: "POST",
        body: JSON.stringify({
          initial_agent: "executor",
          task_type: "implement_small",
          message: "implement the change",
        }),
      }),
      services,
    );

    expect(res.status).toBe(400);
    const body = await readJsonBody<ChainResponseBody>(res);
    expect(body.error?.code).toBe("unknown_agent");
    expect(
      services.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM handoffs").get()?.c ?? 0,
    ).toBe(0);
  });
}

test("chain_start auto routing does not explore an unknown name", async () => {
  const services = tempServices({
    agentRegistry: ["planner-seat"],
    agentRouting: {
      agents: [{ name: "planner-seat", roles: ["planner"] }],
      default_roles: {},
    },
  });
  services.taskRouterConfig = TaskRouterConfigSchema.parse({ mode: "auto" });

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "not-a-role-or-seat",
        task_type: "implement_small",
        message: "implement the change",
      }),
    }),
    services,
  );

  expect(res.status).toBe(400);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error?.code).toBe("unknown_agent");
  expect(
    services.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM routing_decisions").get()?.c ??
      0,
  ).toBe(0);
});

test("chain_start auto routing fails closed when a known zero-holder role has no explorable seat", async () => {
  const services = tempServices({
    agentRegistry: ["fenced-seat"],
    agentRouting: {
      agents: [
        { name: "offline-executor", roles: ["executor"] },
        { name: "fenced-seat", roles: [] },
      ],
      default_roles: {},
    },
  });
  services.taskRouterConfig = TaskRouterConfigSchema.parse({ mode: "auto" });

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "executor",
        task_type: "implement_small",
        message: "implement the change",
      }),
    }),
    services,
  );

  expect(res.status).toBe(422);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error?.code).toBe("router_hard_constraint_exhausted");
  expect(
    services.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM handoffs").get()?.c ?? 0,
  ).toBe(0);
});

test("chain_start auto routing does not re-admit a same-named concrete seat after zero-holder exploration returns null", async () => {
  const services = tempServices({
    agentRegistry: ["executor"],
    agentRouting: {
      agents: [
        { name: "offline-executor", roles: ["executor"] },
        {
          name: "executor",
          roles: ["reviewer"],
          pricing_mode: "subscription",
          subscription_provider: "openai",
        },
      ],
      default_roles: {},
    },
  });
  seedPerformance(services, {
    performance_id: "p-pressured-collision",
    handoff_id: "h-pressured-collision",
    agent_name: "executor",
    task_type: "implement_small",
    outcome: "merged",
  });
  seedSubscriptionPressure(services, "openai", 95);
  services.taskRouterConfig = TaskRouterConfigSchema.parse({ mode: "auto" });
  services.modelAliasMap = {};

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "executor",
        task_type: "implement_small",
        message: "implement the change",
      }),
    }),
    services,
  );

  expect(res.status).toBe(422);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error?.code).toBe("role_route_unavailable");
  expect(
    services.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM handoffs").get()?.c ?? 0,
  ).toBe(0);
});

test("chain_start forwards tool_free through the request schema into auto-router constraints", async () => {
  const services = tempServices({
    agentRegistry: ["http-seat", "tool-seat"],
    agentRouting: {
      agents: [
        {
          name: "http-seat",
          roles: ["executor"],
          pricing_mode: "subscription",
          subscription_provider: "openai",
          adapter: "openai-compat-http",
        },
        {
          name: "tool-seat",
          roles: ["executor"],
          pricing_mode: "subscription",
          subscription_provider: "anthropic",
          adapter: "stdio-acp",
        },
      ],
      default_roles: {},
      role_exploration_policy: "ranked-first",
    },
  });
  for (const agent of ["http-seat", "tool-seat"] as const) {
    seedPerformance(services, {
      performance_id: `p-tool-free-${agent}`,
      handoff_id: `h-tool-free-${agent}`,
      agent_name: agent,
      task_type: "implement_small",
      outcome: "merged",
    });
  }
  services.taskRouterConfig = TaskRouterConfigSchema.parse({ mode: "auto" });
  services.modelAliasMap = {};

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "executor",
        task_type: "implement_small",
        message: "summarize the implementation",
        tool_free: true,
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.routed_agent).toBe("http-seat");
  const decisions = readRoutingDecisions(services.db, { handoffId: body.handoff_id! });
  expect(decisions).toHaveLength(1);
  expect(decisions[0].selectedAgent).toBe("http-seat");
  expect(decisions[0].alternatives).not.toContainEqual(
    expect.objectContaining({
      routeId: "openai:http-seat",
      excluded: true,
    }),
  );
});

test("chain_start records an auto decision as unapplied when classifier fallback changes the final agent", async () => {
  const services = tempServices({
    agentRegistry: ["gemini", "codex-mini"],
    agentRouting: executorRouting(),
  });
  seedExecutorLedger(services);
  services.taskRouterConfig = TaskRouterConfigSchema.parse({ mode: "auto" });
  services.modelAliasMap = {};
  services.localSeatHealth = {
    getUnhealthyAgents: (): Set<string> => new Set(["codex-mini"]),
  };
  services.agentchatConfig = { agents: executorRouting().agents };
  services.handoffWriter.createApproved({
    handoff_id: "parent-classifier-declined",
    ts: services.clock().toISOString(),
    project_id: null,
    conversation_id: "conv-parent",
    from: "user",
    to: "maestro",
    to_role: null,
    message: "parent dispatch",
    triggered_by_event_id: null,
    resolved_by: "test",
    resolved_at: services.clock().toISOString(),
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
    branch_base: null,
  });
  services.dispatchEventLog.record({
    handoff_id: "parent-classifier-declined",
    worker_id: "worker-1",
    source: "worker",
    kind: "dispatch.end",
    ts: services.clock().toISOString(),
    meta: {
      status: "error",
      classifier_declined: true,
      decline_reason: "provider_safety_refusal",
    },
  });

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "executor",
        parent_handoff_id: "parent-classifier-declined",
        task_type: "implement_substantial",
        message: "implement the change",
        use_worktree: false,
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.to_agent).toBe("codex-mini");
  expect(handoff.to_role).toBeNull();

  const decisions = readRoutingDecisions(services.db, { handoffId: body.handoff_id! });
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({
    selectedAgent: "gemini",
    role: "executor",
    applied: false,
  });
});

test("chain_start with taskRouterConfig mode:'auto' fails with a legible 422 (no fallback, no handoff) and persists the denied routing decision when every candidate is hard-excluded", async () => {
  const services = tempServices({
    agentRegistry: ["gemini", "codex-mini"],
    agentRouting: executorRouting(),
  });
  services.taskRouterConfig = TaskRouterConfigSchema.parse({ mode: "auto" });
  services.modelAliasMap = {};
  services.localSeatHealth = {
    getUnhealthyAgents: (): Set<string> => new Set(["gemini", "codex-mini"]),
  };

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "executor",
        task_type: "implement_substantial",
        message: "implement the change",
      }),
    }),
    services,
  );

  expect(res.status).toBe(422);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error?.code).toBe("router_hard_constraint_exhausted");
  expect(body.error?.reasons).toEqual([
    {
      route_id: "unknown:gemini",
      reasons: ["unhealthy_or_unavailable"],
    },
    {
      route_id: "unknown:codex-mini",
      reasons: ["unhealthy_or_unavailable"],
    },
  ]);

  const handoffCount = services.db
    .query<{ c: number }, []>("SELECT COUNT(*) as c FROM handoffs")
    .get();
  expect(handoffCount?.c ?? 0).toBe(0);
  const decisions = readRoutingDecisions(services.db, { handoffId: null });
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({
    handoffId: null,
    mode: "auto",
    role: "executor",
    selectedAgent: null,
    applied: false,
  });
  expect(decisions[0]?.alternatives).toEqual([
    {
      routeId: "unknown:gemini",
      excluded: true,
      reasons: ["unhealthy_or_unavailable"],
    },
    {
      routeId: "unknown:codex-mini",
      excluded: true,
      reasons: ["unhealthy_or_unavailable"],
    },
  ]);
});

test("chain_start with an explicit agent: pin bypasses the router even in mode:'auto', and is recorded as such (no router reason, no decision row)", async () => {
  const services = tempServices({
    agentRegistry: ["gemini", "codex-mini"],
    agentRouting: executorRouting(),
  });
  services.taskRouterConfig = TaskRouterConfigSchema.parse({ mode: "auto" });
  services.modelAliasMap = {};
  // Would hard-exclude every role candidate if the router ever evaluated
  // this dispatch -- proves the pin never reaches the router at all.
  services.localSeatHealth = {
    getUnhealthyAgents: (): Set<string> => new Set(["gemini", "codex-mini"]),
  };

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "agent:codex-mini",
        task_type: "implement_substantial",
        message: "implement the change",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.routing_resolution_reason).toBeUndefined();
  const handoff = selectHandoff(services, body.handoff_id!);
  expect(handoff.to_agent).toBe("codex-mini");

  const decisions = readRoutingDecisions(services.db, { handoffId: body.handoff_id! });
  expect(decisions).toHaveLength(0);
});

test("branch naming is unaffected by taskRouterConfig mode ('auto' vs 'off') for the same input", async () => {
  const requestBody = {
    initial_agent: "executor",
    task_type: "implement_substantial",
    task_name: "add router wiring",
    message: "implement the change",
  };

  const offServices = tempServices({
    agentRegistry: ["gemini", "codex-mini"],
    agentRouting: executorRouting(),
  });
  seedExecutorLedger(offServices);
  offServices.taskRouterConfig = TaskRouterConfigSchema.parse({ mode: "off" });
  const offRes = await chainStartFromInput(requestBody, offServices);
  expect(offRes.status).toBe(200);
  const offBody = await readJsonBody<ChainResponseBody>(offRes);

  const autoServices = tempServices({
    agentRegistry: ["gemini", "codex-mini"],
    agentRouting: executorRouting(),
  });
  seedExecutorLedger(autoServices);
  autoServices.taskRouterConfig = TaskRouterConfigSchema.parse({ mode: "auto" });
  autoServices.modelAliasMap = {};
  const autoRes = await chainStartFromInput(requestBody, autoServices);
  expect(autoRes.status).toBe(200);
  const autoBody = await readJsonBody<ChainResponseBody>(autoRes);

  expect(autoBody.branch_name).not.toBeNull();
  expect(autoBody.branch_name).toBe(offBody.branch_name);
});

type PermissionProfileBody = { permission_profile?: string | null };

type ProfileAwareServices = Services & {
  agentchatConfig?: {
    agents?: {
      name: string;
      roles?: string[];
      adapter?: string;
      enforces_permission_profiles?: string[];
    }[];
  };
  workerAuthz?: WorkerAuthzMap;
};

function seedLiveWorker(
  services: Services,
  metadata: Record<string, unknown> | null,
  opts?: { workerId?: string; staleMs?: number; revoked?: boolean },
): void {
  const now = Date.now();
  const workerId = opts?.workerId ?? "w-live";
  const staleMs = opts?.staleMs ?? 0;
  services.db.run(
    `INSERT INTO worker_tokens (token_hash, worker_id, issued_at, last_seen_at, revoked_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      `th-${workerId}-${String(now)}-${String(staleMs)}`,
      workerId,
      now - 60_000,
      now - staleMs,
      opts?.revoked ? now : null,
      metadata === null ? null : JSON.stringify(metadata),
    ],
  );
}

function enforcingServices(
  seats: { name: string; roles?: string[]; adapter?: string; enforces?: string[] }[],
  routing?: AgentRoutingConfig,
  opts?: { liveEnforcingWorker?: boolean },
): Services {
  const services = tempServices({
    agentRegistry: seats.map((seat) => seat.name),
    agentRouting: routing ?? null,
  }) as ProfileAwareServices;
  services.agentchatConfig = {
    agents: seats.map((seat) => ({
      name: seat.name,
      roles: seat.roles ?? [],
      adapter: seat.adapter,
      enforces_permission_profiles: seat.enforces,
    })),
  };
  // A profiled chain_start also requires a live worker declaring enforcement;
  // every profiled fixture seeds one so the seat gate stays the testable gate.
  if (opts?.liveEnforcingWorker !== false) {
    seedLiveWorker(services, { enforces_permission_profiles: ["review_readonly"] });
  }
  return services;
}

function readHandoffProfile(services: Services, handoff_id: string): string | null {
  return (
    services.db
      .query<
        { permission_profile: string | null },
        [string]
      >("SELECT permission_profile FROM handoffs WHERE handoff_id = ?")
      .get(handoff_id)?.permission_profile ?? null
  );
}

test("chain_start defaults review_adversarial use_worktree:false to review_readonly, persists and echoes it", async () => {
  const services = enforcingServices([{ name: "reviewer-seat", adapter: "opencode-acp" }]);
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "reviewer-seat",
        task_type: "review_adversarial",
        message: "review this diff",
        use_worktree: false,
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody & PermissionProfileBody>(res);
  expect(body.permission_profile).toBe("review_readonly");
  expect(readHandoffProfile(services, body.handoff_id!)).toBe("review_readonly");
});

test("chain_start defaults plan_refine use_worktree:false to review_readonly", async () => {
  const services = enforcingServices([{ name: "planner-seat", adapter: "opencode-acp" }]);
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner-seat",
        task_type: "plan_refine",
        message: "refine this plan",
        use_worktree: false,
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody & PermissionProfileBody>(res);
  expect(body.permission_profile).toBe("review_readonly");
  expect(readHandoffProfile(services, body.handoff_id!)).toBe("review_readonly");
});

test("chain_start does not default the profile when use_worktree stays true", async () => {
  const services = enforcingServices([{ name: "reviewer-seat", adapter: "opencode-acp" }]);
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "reviewer-seat",
        task_type: "review_adversarial",
        message: "review in a worktree",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody & PermissionProfileBody>(res);
  expect(body.permission_profile === undefined || body.permission_profile === null).toBe(true);
  expect(readHandoffProfile(services, body.handoff_id!)).toBeNull();
});

test("chain_start does not default the profile for non-review task types", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        task_type: "implement_small",
        message: "no-worktree implement task",
        use_worktree: false,
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody & PermissionProfileBody>(res);
  expect(body.permission_profile === undefined || body.permission_profile === null).toBe(true);
  expect(readHandoffProfile(services, body.handoff_id!)).toBeNull();
});

test("chain_start preserves an explicit permission_profile and echoes it", async () => {
  const services = enforcingServices([{ name: "reviewer-seat", adapter: "opencode-acp" }]);
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "reviewer-seat",
        task_type: "implement_small",
        message: "explicit profile dispatch",
        permission_profile: "review_readonly",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody & PermissionProfileBody>(res);
  expect(body.permission_profile).toBe("review_readonly");
  expect(readHandoffProfile(services, body.handoff_id!)).toBe("review_readonly");
});

test("chain_start rejects a profile dispatch when the routed seat cannot enforce it", async () => {
  const services = enforcingServices([{ name: "cli-seat", adapter: "claude-cli" }]);
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "cli-seat",
        task_type: "review_adversarial",
        message: "review this diff",
        use_worktree: false,
      }),
    }),
    services,
  );
  expect(res.status).toBe(422);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error?.code).toBe("permission_profile_unenforceable");
  expect(
    services.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM handoffs").get()?.c ?? 0,
  ).toBe(0);
});

test("chain_start fails closed when a profile dispatch has no seat metadata", async () => {
  const services = tempServices({ agentRegistry: ["reviewer-seat"] });
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "reviewer-seat",
        task_type: "review_adversarial",
        message: "review this diff",
        use_worktree: false,
      }),
    }),
    services,
  );
  expect(res.status).toBe(422);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error?.code).toBe("permission_profile_unenforceable");
});

test("chain_start accepts a profile dispatch when the seat opts in via enforces_permission_profiles", async () => {
  const services = enforcingServices([
    { name: "cli-seat", adapter: "claude-cli", enforces: ["review_readonly"] },
  ]);
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "cli-seat",
        task_type: "review_adversarial",
        message: "review this diff",
        use_worktree: false,
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody & PermissionProfileBody>(res);
  expect(body.permission_profile).toBe("review_readonly");
});

test("chain_start role routing excludes non-enforcing role members under a profile dispatch", async () => {
  const routing: AgentRoutingConfig = {
    agents: [
      { name: "plain-review", roles: ["reviewer"], adapter: "claude-cli" },
      {
        name: "enforced-review",
        roles: ["reviewer"],
        adapter: "claude-cli",
        enforces_permission_profiles: ["review_readonly"],
      },
    ],
    default_roles: { reviewer: "plain-review" },
    role_exploration_policy: "ranked-first",
  };
  const services = tempServices({
    agentRegistry: ["plain-review", "enforced-review"],
    agentRouting: routing,
  }) as ProfileAwareServices;
  services.agentchatConfig = {
    agents: [
      { name: "plain-review", roles: ["reviewer"], adapter: "claude-cli" },
      {
        name: "enforced-review",
        roles: ["reviewer"],
        adapter: "claude-cli",
        enforces_permission_profiles: ["review_readonly"],
      },
    ],
  };
  seedLiveWorker(services, { enforces_permission_profiles: ["review_readonly"] });
  for (const agent of ["plain-review", "enforced-review"] as const) {
    seedPerformance(services, {
      performance_id: `p-profile-${agent}`,
      handoff_id: `h-profile-${agent}`,
      agent_name: agent,
      task_type: "review_adversarial",
      outcome: "merged",
    });
  }

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "reviewer",
        task_type: "review_adversarial",
        message: "adversarial review",
        use_worktree: false,
        permission_profile: "review_readonly",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody & PermissionProfileBody>(res);
  expect(body.routed_agent).toBe("enforced-review");
  expect(readHandoffProfile(services, body.handoff_id!)).toBe("review_readonly");
});

function readHandoffCallerCwd(services: Services, handoff_id: string): string | null {
  return (
    services.db
      .query<
        { caller_cwd: string | null },
        [string]
      >("SELECT caller_cwd FROM handoffs WHERE handoff_id = ?")
      .get(handoff_id)?.caller_cwd ?? null
  );
}

test("chain_start persists caller_cwd on the handoff row", async () => {
  const services = enforcingServices([{ name: "reviewer-seat", adapter: "opencode-acp" }]);
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "reviewer-seat",
        task_type: "review_adversarial",
        message: "review this diff",
        use_worktree: false,
        caller_cwd: "/Volumes/WorkSSD/repos/penumbra",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody & PermissionProfileBody>(res);
  expect(readHandoffCallerCwd(services, body.handoff_id!)).toBe("/Volumes/WorkSSD/repos/penumbra");
});

test("chain_start leaves caller_cwd null when the caller omits it", async () => {
  const services = enforcingServices([{ name: "reviewer-seat", adapter: "opencode-acp" }]);
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "reviewer-seat",
        task_type: "review_adversarial",
        message: "review this diff",
        use_worktree: false,
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody & PermissionProfileBody>(res);
  expect(readHandoffCallerCwd(services, body.handoff_id!)).toBeNull();
});

test("chain_start hop inherits the parent's permission_profile and caller_cwd", async () => {
  const services = enforcingServices([
    { name: "reviewer-seat", adapter: "opencode-acp", enforces: ["review_readonly"] },
  ]);
  services.handoffWriter.createApproved({
    handoff_id: "h-profiled-parent",
    ts: "2026-10-01T10:00:00.000Z",
    project_id: "penumbra",
    conversation_id: "conv-parent",
    from: "user",
    to: "reviewer-seat",
    to_role: null,
    message: "root",
    triggered_by_event_id: "evt-parent",
    resolved_by: "chain-start",
    resolved_at: null,
    chain_max_hops: 4,
    chain_trust_mode: "all",
    chain_task_type: "review_adversarial",
    use_worktree: false,
    parent_handoff_id: null,
    permission_profile: "review_readonly",
    caller_cwd: "/Volumes/WorkSSD/repos/penumbra",
  });

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "reviewer-seat",
        message: "follow-up hop",
        conversation_id: "conv-hop",
        task_type: "unknown",
        use_worktree: true,
        parent_handoff_id: "h-profiled-parent",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody & PermissionProfileBody>(res);
  expect(body.permission_profile).toBe("review_readonly");
  expect(readHandoffProfile(services, body.handoff_id!)).toBe("review_readonly");
  expect(readHandoffCallerCwd(services, body.handoff_id!)).toBe("/Volumes/WorkSSD/repos/penumbra");
});

test("chain_start hop under a profiled parent fails closed when the hop seat cannot enforce", async () => {
  const services = enforcingServices([
    { name: "reviewer-seat", adapter: "opencode-acp", enforces: ["review_readonly"] },
    { name: "plain-seat", adapter: "claude-cli" },
  ]);
  services.handoffWriter.createApproved({
    handoff_id: "h-profiled-parent-2",
    ts: "2026-10-01T10:00:00.000Z",
    project_id: "penumbra",
    conversation_id: "conv-parent",
    from: "user",
    to: "reviewer-seat",
    to_role: null,
    message: "root",
    triggered_by_event_id: "evt-parent-2",
    resolved_by: "chain-start",
    resolved_at: null,
    chain_max_hops: 4,
    chain_trust_mode: "all",
    chain_task_type: "review_adversarial",
    use_worktree: false,
    parent_handoff_id: null,
    permission_profile: "review_readonly",
  });

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "plain-seat",
        message: "hop to a non-enforcing seat",
        conversation_id: "conv-hop-escape",
        task_type: "implement_small",
        parent_handoff_id: "h-profiled-parent-2",
      }),
    }),
    services,
  );
  expect(res.status).toBe(422);
  const body = await readJsonBody<ChainResponseBody>(res);
  expect(body.error?.code).toBe("permission_profile_unenforceable");
});

test("chain_start rejects a profiled dispatch when no live worker declares enforcement", async () => {
  const services = enforcingServices(
    [{ name: "reviewer-seat", adapter: "opencode-acp", enforces: ["review_readonly"] }],
    undefined,
    { liveEnforcingWorker: false },
  );
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "reviewer-seat",
        task_type: "review_adversarial",
        message: "review this diff",
        use_worktree: false,
        permission_profile: "review_readonly",
      }),
    }),
    services,
  );
  expect(res.status).toBe(503);
  const body = await readJsonBody<ChainResponseBody & PermissionProfileBody>(res);
  expect(body.error?.code).toBe("permission_profile_unenforceable");
  expect(
    services.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM handoffs").get()?.c ?? 0,
  ).toBe(0);
});

test("chain_start rejects a profiled dispatch when live workers are stale, revoked, or undeclared", async () => {
  const services = enforcingServices(
    [{ name: "reviewer-seat", adapter: "opencode-acp", enforces: ["review_readonly"] }],
    undefined,
    { liveEnforcingWorker: false },
  );
  seedLiveWorker(
    services,
    { enforces_permission_profiles: ["review_readonly"] },
    {
      workerId: "w-stale",
      staleMs: 200_000,
    },
  );
  seedLiveWorker(
    services,
    { enforces_permission_profiles: ["review_readonly"] },
    {
      workerId: "w-revoked",
      revoked: true,
    },
  );
  seedLiveWorker(services, { some_other_metadata: true }, { workerId: "w-undeclared" });
  seedLiveWorker(
    services,
    { enforces_permission_profiles: ["some_other_profile"] },
    { workerId: "w-wrong-profile" },
  );

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "reviewer-seat",
        task_type: "review_adversarial",
        message: "review this diff",
        use_worktree: false,
        permission_profile: "review_readonly",
      }),
    }),
    services,
  );
  expect(res.status).toBe(503);
  const body = await readJsonBody<ChainResponseBody & PermissionProfileBody>(res);
  expect(body.error?.code).toBe("permission_profile_unenforceable");
});

test("chain_start accepts a profiled dispatch when a live worker declares enforcement", async () => {
  const services = enforcingServices([
    { name: "reviewer-seat", adapter: "opencode-acp", enforces: ["review_readonly"] },
  ]);
  seedLiveWorker(
    services,
    { enforces_permission_profiles: ["review_readonly"] },
    {
      workerId: "w-explicit",
    },
  );

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "reviewer-seat",
        task_type: "review_adversarial",
        message: "review this diff",
        use_worktree: false,
        permission_profile: "review_readonly",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody & PermissionProfileBody>(res);
  expect(body.permission_profile).toBe("review_readonly");
});

test("chain_start does not require an enforcing worker when no profile applies", async () => {
  const services = tempServices({ agentRegistry: ["worker-seat"] });
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "worker-seat",
        task_type: "implement_small",
        message: "unprofiled dispatch",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
});

test("chain_start 503s when the only fresh enforcing worker is hard-isolated to another project", async () => {
  const services = enforcingServices(
    [{ name: "reviewer-seat", adapter: "opencode-acp", enforces: ["review_readonly"] }],
    undefined,
    { liveEnforcingWorker: false },
  );
  seedLiveWorker(
    services,
    { enforces_permission_profiles: ["review_readonly"] },
    { workerId: "w-isolated" },
  );
  (services as ProfileAwareServices).workerAuthz = new Map([
    ["w-isolated", { project_id: "other-project", isolation: "hard" }],
  ]);

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "reviewer-seat",
        task_type: "review_adversarial",
        message: "review this diff",
        use_worktree: false,
        permission_profile: "review_readonly",
        project_id: "penumbra",
      }),
    }),
    services,
  );
  expect(res.status).toBe(503);
  const body = await readJsonBody<ChainResponseBody & PermissionProfileBody>(res);
  expect(body.error?.code).toBe("permission_profile_unenforceable");
});

test("chain_start admits a profiled dispatch when the enforcing worker's hard isolation matches the project", async () => {
  const services = enforcingServices(
    [{ name: "reviewer-seat", adapter: "opencode-acp", enforces: ["review_readonly"] }],
    undefined,
    { liveEnforcingWorker: false },
  );
  seedLiveWorker(
    services,
    { enforces_permission_profiles: ["review_readonly"] },
    { workerId: "w-isolated" },
  );
  (services as ProfileAwareServices).workerAuthz = new Map([
    ["w-isolated", { project_id: "penumbra", isolation: "hard" }],
  ]);

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "reviewer-seat",
        task_type: "review_adversarial",
        message: "review this diff",
        use_worktree: false,
        permission_profile: "review_readonly",
        project_id: "penumbra",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
});

test("chain_start 503s when a worker's newest fresh token lacks the profile declaration", async () => {
  const services = enforcingServices(
    [{ name: "reviewer-seat", adapter: "opencode-acp", enforces: ["review_readonly"] }],
    undefined,
    { liveEnforcingWorker: false },
  );
  // Same worker, two fresh tokens: the older declares enforcement, the newer
  // does not — the dedupe keeps the newest row, so this worker does not count.
  seedLiveWorker(
    services,
    { enforces_permission_profiles: ["review_readonly"] },
    { workerId: "w-flip", staleMs: 60_000 },
  );
  seedLiveWorker(services, { other: true }, { workerId: "w-flip", staleMs: 1_000 });

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "reviewer-seat",
        task_type: "review_adversarial",
        message: "review this diff",
        use_worktree: false,
        permission_profile: "review_readonly",
      }),
    }),
    services,
  );
  expect(res.status).toBe(503);
  const body = await readJsonBody<ChainResponseBody & PermissionProfileBody>(res);
  expect(body.error?.code).toBe("permission_profile_unenforceable");
});

test("chain_start admits a profiled dispatch when a worker's newest fresh token declares the profile", async () => {
  const services = enforcingServices(
    [{ name: "reviewer-seat", adapter: "opencode-acp", enforces: ["review_readonly"] }],
    undefined,
    { liveEnforcingWorker: false },
  );
  // Newest token wins the dedupe — the stale older row without the
  // declaration must not mask it.
  seedLiveWorker(services, { other: true }, { workerId: "w-flip", staleMs: 60_000 });
  seedLiveWorker(
    services,
    { enforces_permission_profiles: ["review_readonly"] },
    { workerId: "w-flip", staleMs: 1_000 },
  );

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "reviewer-seat",
        task_type: "review_adversarial",
        message: "review this diff",
        use_worktree: false,
        permission_profile: "review_readonly",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonBody<ChainResponseBody & PermissionProfileBody>(res);
  expect(body.permission_profile).toBe("review_readonly");
});
