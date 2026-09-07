import {
  AgentPerformanceWriter,
  buildServices,
  DispatchEventLog,
  HandoffReader,
  HandoffWriter,
  loadSqliteVec,
  migrate,
  ProjectRegistry,
  type Services,
  type T0Event,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { registerWorkerForTest } from "@penumbra/daemon/test-utils";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { reconcileLongLivedAgents } from "@src/long-lived/reconciler.js";
import {
  handoffsApproveRoute,
  handoffsCompleteRoute,
  handoffsCreateRoute,
  handoffsFailRoute,
  handoffsGetRoute,
  handoffsLatestRoute,
  handoffsListPendingRoute,
} from "@src/routes/handoffs.js";
import { createDaemonFetchHandler } from "@src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

// File-local response-body shapes matching the route emits this file exercises.
// Tests only inspect the fields captured here; the route module is unchanged.
interface HandoffSummary {
  handoff_id: string;
  status: string;
  project_id: string | null;
}
interface CreateBody {
  ok?: boolean;
  status: string;
  handoff_id: string;
  routed_agent?: string;
  routed_role?: string | null;
  routing_task_type?: string | null;
}
interface ApproveBody {
  handoff_id: string;
  status: string;
  reason?: string;
}
interface CompleteBody {
  handoff_id: string;
  status: string;
  reason?: string;
}
interface FailBody {
  handoff_id: string;
  status: string;
}
interface ClaimBody {
  handoff_id?: string;
  status?: string;
  current_status?: string;
}
interface ListBody {
  handoffs: HandoffSummary[];
}
interface DoneBody {
  done: number;
}
interface ProjectErrorBody {
  error: { code: string; project_id?: string };
}
interface ErrorCodeBody {
  error: { code: string; depth?: number; cap?: number };
}
interface GetBody {
  handoff: HandoffSummary;
}
interface GetErrorBody {
  error: { code: string };
}
interface LatestBody {
  handoff: HandoffSummary;
}

async function readJsonAs<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// Tests stub log methods with no-op handlers; pino's Logger expects functions
// returning undefined. Using a named helper avoids the no-empty-function rule
// triggered by inline `() => {}` bodies.
function noopLog(): undefined {
  return undefined;
}

// workerAuthz lives on DaemonServices (daemon's serve.ts), not the core Services.
// Routes accept DaemonServices and read it through the optional field. The cast
// here is the single documented gap between the core Services type imported by
// these tests and DaemonServices' workerAuthz extension.
type WorkerAuthzMap = Map<string, { project_id?: string; isolation: "hard" | "sticky" | "shared" }>;
function stubWorkerAuthz(
  services: Services,
  entries: [string, { project_id: string; isolation: "hard" | "sticky" | "shared" }][],
): void {
  (services as Services & { workerAuthz?: WorkerAuthzMap }).workerAuthz = new Map(entries);
}

// The Services interface from core declares dozens of required wirings. These
// tests only exercise the handoff routes, so we mock the minimal surface and
// route the single cross-type gap through a typed factory.
function makeServices(db: Database): Services {
  const writer = new HandoffWriter({ db });
  const reader = new HandoffReader({ db });
  let n = 0;
  const t0Events: T0Event[] = [];
  return {
    db,
    handoffWriter: writer,
    handoffReader: reader,
    dispatchEventLog: new DispatchEventLog(db),
    machineId: { get: (): string => "machine-test" },
    uuid: (): string => `evt-${String(++n)}`,
    clock: (): Date => new Date("2026-04-25T20:00:00.000Z"),
    t0Writer: {
      write: (event: T0Event): string => {
        t0Events.push(event);
        return event.event_id;
      },
    },
    redactor: { redact: (s: unknown): unknown => s },
    log: { info: noopLog, warn: noopLog },
    __testT0Events: t0Events,
  } as unknown as Services;
}

function countHandoffRows(db: Database, message: string): number {
  return (
    db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM handoffs WHERE message=?")
      .get(message)?.n ?? 0
  );
}

function countAgentHandoffEvents(services: Services, summary: string): number {
  const events = (services as Services & { __testT0Events?: T0Event[] }).__testT0Events ?? [];
  return events.filter(
    (event) => event.event_type === "agent-handoff" && event.payload_summary === summary,
  ).length;
}

// AgentConfig has dozens of required fields, but reconcileLongLivedAgents only
// reads the fields supplied below. One documented `as unknown as AgentConfig`
// cast inside a typed factory keeps the test fixture compact.
type AgentConfigParam = Parameters<typeof reconcileLongLivedAgents>[1][number];
function makeLongLivedAgentConfig(name: string): AgentConfigParam {
  return {
    name,
    long_lived: true,
    long_lived_config: {
      schedule_cron: "*/15 * * * *",
      subscriptions: [],
      mcp_allowlist: [],
      bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3,
      standing_brief: "x",
    },
  } as unknown as AgentConfigParam;
}

function seedPerformance(
  db: Database,
  input: {
    performance_id: string;
    handoff_id: string;
    agent_name: string;
    outcome: "merged" | "failed";
  },
): void {
  new AgentPerformanceWriter(db).upsert({
    performance_id: input.performance_id,
    ts: "2026-04-25T19:00:00.000Z",
    handoff_id: input.handoff_id,
    conversation_id: "conv-ledger",
    project_id: null,
    agent_name: input.agent_name,
    task_type: "implement_small",
    outcome: input.outcome,
    rounds: input.outcome === "merged" ? 1 : 4,
    smoke_pass: input.outcome === "merged" ? "y" : "n",
    reviewer_findings: null,
    maestro_score: 5,
    cost_usd: null,
    tokens_used: null,
    latency_ms: null,
    source: "manual_seed",
    notes: null,
    metadata_json: "{}",
  });
}

test("POST /handoffs creates a pending handoff and returns the id", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const req = new Request("http://x/handoffs", {
    method: "POST",
    body: JSON.stringify({
      from: "claude",
      to: "gemini",
      to_role: "executor",
      message: "go",
      conversation_id: "conv-7",
      project_id: "auth-svc",
      triggered_by_event_id: "evt-source-1",
    }),
  });
  const res = await handoffsCreateRoute(req, services);
  expect(res.status).toBe(200);
  const body = await readJsonAs<CreateBody>(res);
  expect(body.status).toBe("pending");
  expect(typeof body.handoff_id).toBe("string");

  const row = db
    .query<{ status: string }, [string]>("SELECT status FROM handoffs WHERE handoff_id=?")
    .get(body.handoff_id);
  expect(row?.status).toBe("pending");
});

test("POST /handoffs persists isolated_install", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const res = await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "claude",
        to: "gemini",
        message: "go",
        conversation_id: "conv-isolated",
        project_id: null,
        triggered_by_event_id: "evt-source-isolated",
        use_worktree: true,
        isolated_install: true,
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<CreateBody>(res);

  const row = db
    .query<
      { use_worktree: number | null; isolated_install: number | null },
      [string]
    >("SELECT use_worktree, isolated_install FROM handoffs WHERE handoff_id=?")
    .get(body.handoff_id);
  expect(row).toEqual({ use_worktree: 1, isolated_install: 1 });
});

test("POST /handoffs persists parent, branch base, and chain max hops", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  services.handoffWriter.createApproved({
    handoff_id: "h-parent",
    ts: "2026-09-01T11:59:00.000Z",
    project_id: null,
    conversation_id: "conv-chain",
    from: "user",
    to: "planner",
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

  const res = await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "planner",
        to: "executor",
        message: "continue",
        conversation_id: "conv-chain",
        project_id: null,
        triggered_by_event_id: "evt-source-chain",
        parent_handoff_id: "h-parent",
        branch_base: "feat/round-one",
        chain_max_hops: 3,
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<CreateBody>(res);

  const row = db
    .query<
      {
        parent_handoff_id: string | null;
        branch_base: string | null;
        chain_max_hops: number | null;
      },
      [string]
    >("SELECT parent_handoff_id, branch_base, chain_max_hops FROM handoffs WHERE handoff_id=?")
    .get(body.handoff_id);
  expect(row).toEqual({
    parent_handoff_id: "h-parent",
    branch_base: "feat/round-one",
    chain_max_hops: 3,
  });
});

test("POST /handoffs rejects an unknown parent before writing t0 or handoff rows", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const res = await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "planner",
        to: "executor",
        message: "unknown parent child",
        conversation_id: "conv-chain",
        project_id: null,
        triggered_by_event_id: "evt-unknown-parent",
        parent_handoff_id: "h-missing-parent",
      }),
    }),
    services,
  );

  expect(res.status).toBe(404);
  const body = await readJsonAs<ErrorCodeBody>(res);
  expect(body.error.code).toBe("parent_not_found");
  expect(countAgentHandoffEvents(services, "unknown parent child")).toBe(0);
  expect(countHandoffRows(db, "unknown parent child")).toBe(0);
});

test("POST /handoffs rejects parent from another conversation before writing t0 or handoff rows", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  services.handoffWriter.createApproved({
    handoff_id: "h-other-conv-parent",
    ts: "2026-09-01T11:59:00.000Z",
    project_id: null,
    conversation_id: "conv-parent",
    from: "user",
    to: "planner",
    to_role: null,
    message: "parent",
    triggered_by_event_id: "evt-parent-other-conv",
    resolved_by: "chain-start",
    resolved_at: null,
    chain_max_hops: 3,
    chain_trust_mode: "all",
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
  });

  const res = await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "planner",
        to: "executor",
        message: "wrong conversation child",
        conversation_id: "conv-child",
        project_id: null,
        triggered_by_event_id: "evt-wrong-conv-parent",
        parent_handoff_id: "h-other-conv-parent",
      }),
    }),
    services,
  );

  expect(res.status).toBe(409);
  const body = await readJsonAs<ErrorCodeBody>(res);
  expect(body.error.code).toBe("parent_conversation_mismatch");
  expect(countAgentHandoffEvents(services, "wrong conversation child")).toBe(0);
  expect(countHandoffRows(db, "wrong conversation child")).toBe(0);
});

test("POST /handoffs leaves parent, branch base, and chain max hops null when omitted", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const res = await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "planner",
        to: "executor",
        message: "continue",
        conversation_id: "conv-chain-null",
        project_id: null,
        triggered_by_event_id: "evt-source-chain-null",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<CreateBody>(res);

  const row = db
    .query<
      {
        parent_handoff_id: string | null;
        branch_base: string | null;
        chain_max_hops: number | null;
      },
      [string]
    >("SELECT parent_handoff_id, branch_base, chain_max_hops FROM handoffs WHERE handoff_id=?")
    .get(body.handoff_id);
  expect(row).toEqual({ parent_handoff_id: null, branch_base: null, chain_max_hops: null });
});

test("POST /handoffs rejects a parent handoff at the recursion depth cap", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  services.handoffWriter.createApproved({
    handoff_id: "h-root",
    ts: "2026-09-01T12:00:00.000Z",
    project_id: null,
    conversation_id: "conv-depth",
    from: "user",
    to: "planner",
    to_role: null,
    message: "root",
    triggered_by_event_id: "evt-root",
    resolved_by: "chain-start",
    resolved_at: null,
    chain_max_hops: 3,
    chain_trust_mode: "all",
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
  });
  services.handoffWriter.createApproved({
    handoff_id: "h-child",
    ts: "2026-09-01T12:01:00.000Z",
    project_id: null,
    conversation_id: "conv-depth",
    from: "planner",
    to: "executor",
    to_role: null,
    message: "child",
    triggered_by_event_id: "evt-child",
    resolved_by: "auto",
    resolved_at: null,
    chain_max_hops: 3,
    chain_trust_mode: "all",
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: "h-root",
  });

  const previousCap = process.env.PENUMBRA_RECURSION_DEPTH_CAP;
  process.env.PENUMBRA_RECURSION_DEPTH_CAP = "2";
  try {
    const res = await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "executor",
          to: "reviewer",
          message: "too deep",
          conversation_id: "conv-depth",
          project_id: null,
          triggered_by_event_id: "evt-too-deep",
          parent_handoff_id: "h-child",
        }),
      }),
      services,
    );
    expect(res.status).toBe(409);
    const body = await readJsonAs<ErrorCodeBody>(res);
    expect(body.error.code).toBe("recursion_depth_exceeded");
    expect(body.error.depth).toBe(2);
    expect(body.error.cap).toBe(2);
    expect(countAgentHandoffEvents(services, "too deep")).toBe(0);
    expect(countHandoffRows(db, "too deep")).toBe(0);
  } finally {
    if (previousCap === undefined) {
      delete process.env.PENUMBRA_RECURSION_DEPTH_CAP;
    } else {
      process.env.PENUMBRA_RECURSION_DEPTH_CAP = previousCap;
    }
  }

  expect(countHandoffRows(db, "too deep")).toBe(0);
});

test("POST /handoffs routes role targets through the ledger", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  services.agentRegistry = ["gemini", "codex-mini"];
  services.agentRouting = {
    agents: [
      { name: "gemini", roles: ["executor"] },
      { name: "codex-mini", roles: ["executor"] },
    ],
    default_roles: { executor: "gemini" },
  };
  seedPerformance(db, {
    performance_id: "p-good",
    handoff_id: "h-good",
    agent_name: "codex-mini",
    outcome: "merged",
  });
  seedPerformance(db, {
    performance_id: "p-bad",
    handoff_id: "h-bad",
    agent_name: "gemini",
    outcome: "failed",
  });

  const res = await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "planner",
        to: "gemini",
        to_role: "executor",
        message: "Task type: implement_small\n\nimplement the tiny change",
        conversation_id: "conv-7",
        project_id: null,
        triggered_by_event_id: "evt-source-1",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonAs<CreateBody>(res);
  expect(body.routed_agent).toBe("codex-mini");
  expect(body.routed_role).toBe("executor");
  expect(body.routing_task_type).toBe("implement_small");

  const row = db
    .query<
      { to_agent: string; to_role: string | null; chain_task_type: string | null },
      [string]
    >("SELECT to_agent, to_role, chain_task_type FROM handoffs WHERE handoff_id=?")
    .get(body.handoff_id);
  expect(row).toEqual({
    to_agent: "codex-mini",
    to_role: "executor",
    chain_task_type: "implement_small",
  });
});

test("POST /handoffs honors ranked-first exploration policy for role routing", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  services.agentRegistry = ["gemini", "codex-mini"];
  services.agentRouting = {
    agents: [
      { name: "gemini", roles: ["executor"] },
      { name: "codex-mini", roles: ["executor"] },
    ],
    default_roles: { executor: "gemini" },
    role_exploration_policy: "ranked-first",
  };
  seedPerformance(db, {
    performance_id: "p-good",
    handoff_id: "h-good",
    agent_name: "gemini",
    outcome: "merged",
  });

  const res = await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "planner",
        to: "gemini",
        to_role: "executor",
        message: "Task type: implement_small\n\nimplement the tiny change",
        conversation_id: "conv-7",
        project_id: null,
        triggered_by_event_id: "evt-source-1",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonAs<CreateBody>(res);
  expect(body.routed_agent).toBe("gemini");
  expect(body.routed_role).toBe("executor");

  const row = db
    .query<
      { to_agent: string; to_role: string | null },
      [string]
    >("SELECT to_agent, to_role FROM handoffs WHERE handoff_id=?")
    .get(body.handoff_id);
  expect(row).toEqual({
    to_agent: "gemini",
    to_role: "executor",
  });
});

test("F6: POST /handoffs rejects unknown agent with did_you_mean when registry is present", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  services.agentRegistry = ["gemini", "codex-mini"];

  const res = await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "claude",
        to: "penumbra", // phantom seat — must be rejected, not silently materialized
        message: "go",
        conversation_id: "c-phantom",
        triggered_by_event_id: "evt-phantom",
      }),
    }),
    services,
  );
  expect(res.status).toBe(400);
  const body = (await res.json()) as {
    error: { code: string; agent: string; did_you_mean: string[] };
  };
  expect(body.error.code).toBe("unknown_agent");
  expect(body.error.agent).toBe("penumbra");
  expect(Array.isArray(body.error.did_you_mean)).toBe(true);

  // Belt-and-suspenders: no handoff row should have been written for the rejected name.
  const row = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM handoffs WHERE to_agent=?")
    .get("penumbra");
  expect(row?.n).toBe(0);
});

test("F6: POST /handoffs accepts a known registry agent unchanged", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  services.agentRegistry = ["gemini", "codex-mini"];

  const res = await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "claude",
        to: "gemini",
        message: "go",
        conversation_id: "c-known",
        triggered_by_event_id: "evt-known",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
});

test("F6: POST /handoffs leaves caller through when agentRegistry is unset (config-less path)", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  // agentRegistry intentionally NOT set — F6 must skip validation rather than
  // wedge during config-reload races or in test fixtures without a registry.
  const res = await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "claude",
        to: "whatever-name",
        message: "go",
        conversation_id: "c-noreg",
        triggered_by_event_id: "evt-noreg",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
});

test("POST /handoffs returns 400 for invalid body", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const req = new Request("http://x/handoffs", {
    method: "POST",
    body: JSON.stringify({ from: "claude" }),
  });
  const res = await handoffsCreateRoute(req, services);
  expect(res.status).toBe(400);
});

test("GET /handoffs/pending returns pending handoffs", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  // seed via the create route
  await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "claude",
        to: "gemini",
        to_role: "executor",
        message: "go",
        conversation_id: "c-1",
        project_id: "auth-svc",
        triggered_by_event_id: "e",
      }),
    }),
    services,
  );

  const res = handoffsListPendingRoute(new Request("http://x/handoffs/pending"), services);
  expect(res.status).toBe(200);
  const body = await readJsonAs<ListBody>(res);
  expect(body.handoffs.length).toBe(1);
  expect(body.handoffs[0]!.status).toBe("pending");
});

test("GET /handoffs/latest returns 400 if conversation_id is missing", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = handoffsLatestRoute(new Request(`http://x/handoffs/latest`), services);
  expect(res.status).toBe(400);
});

test("GET /handoffs/latest returns 404 if no handoffs exist for conversation", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = handoffsLatestRoute(
    new Request(`http://x/handoffs/latest?conversation_id=c-latest-404`),
    services,
  );
  expect(res.status).toBe(404);
});

test("GET /handoffs/latest returns the most recent handoff for a conversation", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  services.handoffWriter.createApproved({
    handoff_id: "h1",
    ts: "2026-04-26T12:00:00Z",
    project_id: "p1",
    conversation_id: "c-latest-200",
    from: "user",
    to: "agent",
    to_role: null,
    message: "hi",
    triggered_by_event_id: "e1",
    resolved_by: "system",
    resolved_at: "2026-04-26T12:00:00Z",
    chain_max_hops: null,
    chain_trust_mode: null,
  });
  services.handoffWriter.createApproved({
    handoff_id: "h2",
    ts: "2026-04-26T12:05:00Z",
    project_id: "p1",
    conversation_id: "c-latest-200",
    from: "user",
    to: "agent2",
    to_role: null,
    message: "hi again",
    triggered_by_event_id: "e2",
    resolved_by: "system",
    resolved_at: "2026-04-26T12:05:00Z",
    chain_max_hops: null,
    chain_trust_mode: null,
  });

  const res = handoffsLatestRoute(
    new Request(`http://x/handoffs/latest?conversation_id=c-latest-200`),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<LatestBody>(res);
  expect(body.handoff.handoff_id).toBe("h2");
});

test("POST /handoffs/:id/approve flips to approved", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const createReq = new Request("http://x/handoffs", {
    method: "POST",
    body: JSON.stringify({
      from: "claude",
      to: "gemini",
      to_role: "executor",
      message: "go",
      conversation_id: "c-1",
      project_id: "auth-svc",
      triggered_by_event_id: "e",
    }),
  });
  const createRes = await handoffsCreateRoute(createReq, services);
  const create = await readJsonAs<CreateBody>(createRes);
  const id = create.handoff_id;

  const res = await handoffsApproveRoute(
    new Request(`http://x/handoffs/${id}/approve`, { method: "POST", body: "{}" }),
    id,
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<ApproveBody>(res);
  expect(body.status).toBe("approved");
});

test("POST /handoffs/:id/approve rejects a misspelled key instead of silently approving", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const createReq = new Request("http://x/handoffs", {
    method: "POST",
    body: JSON.stringify({
      from: "claude",
      to: "gemini",
      to_role: "executor",
      message: "go",
      conversation_id: "c-1",
      project_id: "auth-svc",
      triggered_by_event_id: "e",
    }),
  });
  const createRes = await handoffsCreateRoute(createReq, services);
  const create = await readJsonAs<CreateBody>(createRes);
  const id = create.handoff_id;

  const res = await handoffsApproveRoute(
    new Request(`http://x/handoffs/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ redirec_to: "codex" }),
    }),
    id,
    services,
  );
  expect(res.status).toBe(400);
  const body = await readJsonAs<{
    error: { code: string; field_errors: { path: string[]; message: string }[] };
  }>(res);
  expect(body.error.code).toBe("validation_error");
  expect(JSON.stringify(body.error.field_errors)).toContain("redirec_to");

  const row = db
    .query<{ status: string }, [string]>("SELECT status FROM handoffs WHERE handoff_id=?")
    .get(id);
  expect(row?.status).toBe("pending");
});

test("POST /handoffs/:id/approve returns 409 if already resolved", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const createReq = new Request("http://x/handoffs", {
    method: "POST",
    body: JSON.stringify({
      from: "claude",
      to: "gemini",
      to_role: "executor",
      message: "go",
      conversation_id: "c-1",
      project_id: "auth-svc",
      triggered_by_event_id: "e",
    }),
  });
  const createRes = await handoffsCreateRoute(createReq, services);
  const create = await readJsonAs<CreateBody>(createRes);
  const id = create.handoff_id;

  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${id}/approve`, {
      method: "POST",
      body: "{}",
    }),
    id,
    services,
  );
  const second = await handoffsApproveRoute(
    new Request(`http://x/handoffs/${id}/approve`, {
      method: "POST",
      body: "{}",
    }),
    id,
    services,
  );
  expect(second.status).toBe(409);
});

test("POST /handoffs/:id/approve returns 500 when the writer fails on a pending handoff", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const createReq = new Request("http://x/handoffs", {
    method: "POST",
    body: JSON.stringify({
      from: "claude",
      to: "gemini",
      to_role: "executor",
      message: "go",
      conversation_id: "c-1",
      project_id: "auth-svc",
      triggered_by_event_id: "e",
    }),
  });
  const createRes = await handoffsCreateRoute(createReq, services);
  const create = await readJsonAs<CreateBody>(createRes);
  const id = create.handoff_id;

  const failingServices = {
    ...services,
    handoffWriter: {
      approve: (): never => {
        throw new Error("db exploded");
      },
    },
  } as unknown as Services;
  const res = await handoffsApproveRoute(
    new Request(`http://x/handoffs/${id}/approve`, { method: "POST", body: "{}" }),
    id,
    failingServices,
  );
  expect(res.status).toBe(500);
  const body = await readJsonAs<{ error: { code: string; message: string } }>(res);
  expect(body.error.code).toBe("internal_error");
  expect(body.error.message).toContain("db exploded");
});

test("POST /handoffs/:id/approve accepts optional resolved_by override", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const createReq = new Request("http://x/handoffs", {
    method: "POST",
    body: JSON.stringify({
      from: "claude",
      to: "gemini",
      to_role: "executor",
      message: "go",
      conversation_id: "c-1",
      project_id: "auth-svc",
      triggered_by_event_id: "e",
    }),
  });
  const createRes = await handoffsCreateRoute(createReq, services);
  const create = await readJsonAs<CreateBody>(createRes);
  const id = create.handoff_id;

  const res = await handoffsApproveRoute(
    new Request(`http://x/handoffs/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ resolved_by: "auto" }),
    }),
    id,
    services,
  );
  expect(res.status).toBe(200);

  const row = db
    .query<
      { resolved_by: string | null },
      [string]
    >("SELECT resolved_by FROM handoffs WHERE handoff_id=?")
    .get(id);
  expect(row?.resolved_by).toBe("auto");
});

test("GET /handoffs?status=approved returns only approved rows", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  // seed two handoffs
  await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "a",
        to: "b",
        message: "m1",
        conversation_id: "c1",
        triggered_by_event_id: "e1",
      }),
    }),
    services,
  );
  const created2 = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m2",
          conversation_id: "c1",
          triggered_by_event_id: "e2",
        }),
      }),
      services,
    ),
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${created2.handoff_id}/approve`, { method: "POST", body: "{}" }),
    created2.handoff_id,
    services,
  );

  const res = handoffsListPendingRoute(new Request(`http://x/handoffs?status=approved`), services);
  expect(res.status).toBe(200);
  const body = await readJsonAs<ListBody>(res);
  expect(body.handoffs.length).toBe(1);
  expect(body.handoffs[0]!.handoff_id).toBe(created2.handoff_id);
  expect(body.handoffs[0]!.status).toBe("approved");
});

test("GET /handoffs?status=approved&project_id filters by project_id", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  services.projectRegistry = new ProjectRegistry(
    new Map([
      ["proj-a", { project_id: "proj-a", root_path: "/tmp/proj-a" }],
      ["proj-b", { project_id: "proj-b", root_path: "/tmp/proj-b" }],
    ]),
  );

  const created1 = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "alpha",
          conversation_id: "c1",
          project_id: "proj-a",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    ),
  );
  const created2 = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "beta",
          conversation_id: "c1",
          project_id: "proj-b",
          triggered_by_event_id: "e2",
        }),
      }),
      services,
    ),
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${created1.handoff_id}/approve`, { method: "POST", body: "{}" }),
    created1.handoff_id,
    services,
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${created2.handoff_id}/approve`, { method: "POST", body: "{}" }),
    created2.handoff_id,
    services,
  );

  const res = handoffsListPendingRoute(
    new Request("http://x/handoffs?status=approved&project_id=proj-a"),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<ListBody>(res);
  expect(body.handoffs.length).toBe(1);
  expect(body.handoffs[0]!.project_id).toBe("proj-a");
});

test("GET /handoffs?status=approved for hard worker with no project_id is limited to worker scope", async () => {
  const { services, db } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });
  services.projectRegistry = new ProjectRegistry(
    new Map([
      ["proj-a", { project_id: "proj-a", root_path: "/tmp/proj-a" }],
      ["proj-b", { project_id: "proj-b", root_path: "/tmp/proj-b" }],
    ]),
  );
  stubWorkerAuthz(services, [["worker-hard-projA", { project_id: "proj-a", isolation: "hard" }]]);

  const createdA = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "alpha",
          conversation_id: "c1",
          project_id: "proj-a",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    ),
  );
  const createdB = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "beta",
          conversation_id: "c1",
          project_id: "proj-b",
          triggered_by_event_id: "e2",
        }),
      }),
      services,
    ),
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${createdA.handoff_id}/approve`, { method: "POST", body: "{}" }),
    createdA.handoff_id,
    services,
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${createdB.handoff_id}/approve`, { method: "POST", body: "{}" }),
    createdB.handoff_id,
    services,
  );

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: TOKEN,
    worker_id: "worker-hard-projA",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request(`http://x/handoffs?status=approved`, {
      headers: { authorization: `Bearer ${worker_token}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<ListBody>(res);
  expect(body.handoffs).toHaveLength(1);
  expect(body.handoffs[0]!.project_id).toBe("proj-a");

  const approvedRows = db
    .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM handoffs WHERE status=?")
    .get("approved");
  expect(approvedRows?.count).toBe(2);
});

test("GET /handoffs?status=approved&project_id=proj-b for hard worker yields project_mismatch", async () => {
  const { services } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });
  services.projectRegistry = new ProjectRegistry(
    new Map([
      ["proj-a", { project_id: "proj-a", root_path: "/tmp/proj-a" }],
      ["proj-b", { project_id: "proj-b", root_path: "/tmp/proj-b" }],
    ]),
  );
  stubWorkerAuthz(services, [["worker-hard-projA", { project_id: "proj-a", isolation: "hard" }]]);

  const created = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "alpha",
          conversation_id: "c1",
          project_id: "proj-a",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    ),
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${created.handoff_id}/approve`, { method: "POST", body: "{}" }),
    created.handoff_id,
    services,
  );

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: TOKEN,
    worker_id: "worker-hard-projA",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request(`http://x/handoffs?status=approved&project_id=proj-b`, {
      headers: { authorization: `Bearer ${worker_token}` },
    }),
  );
  expect(res.status).toBe(403);
  const body = await readJsonAs<ProjectErrorBody>(res);
  expect(body.error.code).toBe("project_mismatch");
});

test("GET /handoffs?status=approved for sticky worker without project_id remains unscoped", async () => {
  const { services } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });
  services.projectRegistry = new ProjectRegistry(
    new Map([
      ["proj-a", { project_id: "proj-a", root_path: "/tmp/proj-a" }],
      ["proj-b", { project_id: "proj-b", root_path: "/tmp/proj-b" }],
    ]),
  );
  stubWorkerAuthz(services, [
    ["worker-sticky-projA", { project_id: "proj-a", isolation: "sticky" }],
  ]);

  const createdA = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "alpha",
          conversation_id: "c1",
          project_id: "proj-a",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    ),
  );
  const createdB = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "beta",
          conversation_id: "c1",
          project_id: "proj-b",
          triggered_by_event_id: "e2",
        }),
      }),
      services,
    ),
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${createdA.handoff_id}/approve`, { method: "POST", body: "{}" }),
    createdA.handoff_id,
    services,
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${createdB.handoff_id}/approve`, { method: "POST", body: "{}" }),
    createdB.handoff_id,
    services,
  );

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: TOKEN,
    worker_id: "worker-sticky-projA",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request(`http://x/handoffs?status=approved`, {
      headers: { authorization: `Bearer ${worker_token}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<ListBody>(res);
  expect(body.handoffs).toHaveLength(2);
});

test("GET /handoffs?status=approved for unknown worker token is unscoped", async () => {
  const { services, db } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });
  services.projectRegistry = new ProjectRegistry(
    new Map([
      ["proj-a", { project_id: "proj-a", root_path: "/tmp/proj-a" }],
      ["proj-b", { project_id: "proj-b", root_path: "/tmp/proj-b" }],
    ]),
  );
  stubWorkerAuthz(services, [["worker-hard-projA", { project_id: "proj-a", isolation: "hard" }]]);

  const createdA = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "alpha",
          conversation_id: "c1",
          project_id: "proj-a",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    ),
  );
  const createdB = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "beta",
          conversation_id: "c1",
          project_id: "proj-b",
          triggered_by_event_id: "e2",
        }),
      }),
      services,
    ),
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${createdA.handoff_id}/approve`, { method: "POST", body: "{}" }),
    createdA.handoff_id,
    services,
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${createdB.handoff_id}/approve`, { method: "POST", body: "{}" }),
    createdB.handoff_id,
    services,
  );

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: TOKEN,
    worker_id: "unknown-worker",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request(`http://x/handoffs?status=approved`, {
      headers: { authorization: `Bearer ${worker_token}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<ListBody>(res);
  expect(body.handoffs).toHaveLength(2);

  const approvedRows = db
    .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM handoffs WHERE status=?")
    .get("approved");
  expect(approvedRows?.count).toBe(2);
});

test("GET /handoffs?status=approved&project_id=__null__ returns only null-scoped rows", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const created1 = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "alpha",
          conversation_id: "c1",
          project_id: "proj-a",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    ),
  );
  const created2 = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "null",
          conversation_id: "c1",
          triggered_by_event_id: "e2",
        }),
      }),
      services,
    ),
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${created1.handoff_id}/approve`, { method: "POST", body: "{}" }),
    created1.handoff_id,
    services,
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${created2.handoff_id}/approve`, { method: "POST", body: "{}" }),
    created2.handoff_id,
    services,
  );

  const res = handoffsListPendingRoute(
    new Request("http://x/handoffs?status=approved&project_id=__null__"),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<ListBody>(res);
  expect(body.handoffs.length).toBe(1);
  expect(body.handoffs[0]!.project_id).toBeNull();
});

test("GET /handoffs?status=approved&project_scope=global returns only null-scoped rows", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const created1 = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "alpha",
          conversation_id: "c1",
          project_id: "proj-a",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    ),
  );
  const created2 = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "null",
          conversation_id: "c1",
          triggered_by_event_id: "e2",
        }),
      }),
      services,
    ),
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${created1.handoff_id}/approve`, { method: "POST", body: "{}" }),
    created1.handoff_id,
    services,
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${created2.handoff_id}/approve`, { method: "POST", body: "{}" }),
    created2.handoff_id,
    services,
  );

  const res = handoffsListPendingRoute(
    new Request("http://x/handoffs?status=approved&project_scope=global"),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<ListBody>(res);
  expect(body.handoffs.length).toBe(1);
  expect(body.handoffs[0]!.project_id).toBeNull();
});

test("GET /handoffs?status=approved&project_id=__null__ logs deprecated sentinel warning", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const warns: unknown[][] = [];
  // Override log to capture deprecated-sentinel warnings. The cast targets the
  // narrow Logger shape the route actually exercises.
  (
    services as Services & { log: { info: () => undefined; warn: (...args: unknown[]) => void } }
  ).log = {
    info: noopLog,
    warn: (...args: unknown[]): void => {
      warns.push(args);
    },
  };

  const created1 = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "alpha",
          conversation_id: "c1",
          project_id: "proj-a",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    ),
  );
  const created2 = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "null",
          conversation_id: "c1",
          triggered_by_event_id: "e2",
        }),
      }),
      services,
    ),
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${created1.handoff_id}/approve`, { method: "POST", body: "{}" }),
    created1.handoff_id,
    services,
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${created2.handoff_id}/approve`, { method: "POST", body: "{}" }),
    created2.handoff_id,
    services,
  );

  const res = handoffsListPendingRoute(
    new Request("http://x/handoffs?status=approved&project_id=__null__"),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<ListBody>(res);
  expect(body.handoffs.length).toBe(1);
  expect(warns).toContainEqual([
    {
      event: "deprecated_null_sentinel",
      recommend: "project_scope=global",
    },
    "deprecated null project_id sentinel; prefer project_scope=global",
  ]);
});

test("GET /handoffs?status=approved&project_id=proj-a&project_scope=global returns 400", async () => {
  const res = handoffsListPendingRoute(
    new Request("http://x/handoffs?status=approved&project_id=proj-a&project_scope=global"),
    makeServices(new Database(":memory:")),
  );
  expect(res.status).toBe(400);
  const body = await readJsonAs<ProjectErrorBody>(res);
  expect(body.error.code).toBe("validation_error");
});

test("GET /handoffs?status=approved rejects unknown project_id when registry exists", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  services.projectRegistry = new ProjectRegistry(
    new Map([["proj-a", { project_id: "proj-a", root_path: "/tmp/proj-a" }]]),
  );

  const res = handoffsListPendingRoute(
    new Request("http://x/handoffs?status=approved&project_id=proj-b"),
    services,
  );
  expect(res.status).toBe(400);
  const body = await readJsonAs<ProjectErrorBody>(res);
  expect(body.error.code).toBe("unknown_project");
  expect(body.error.project_id).toBe("proj-b");
});

test("GET /handoffs?status=approved accepts unknown project_id when registry is absent", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const res = handoffsListPendingRoute(
    new Request("http://x/handoffs?status=approved&project_id=proj-b"),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<ListBody>(res);
  expect(body.handoffs).toEqual([]);
});

test("GET /handoffs?status=pending,approved returns both", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const c1 = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m1",
          conversation_id: "c1",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    ),
  );
  const c2 = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m2",
          conversation_id: "c1",
          triggered_by_event_id: "e2",
        }),
      }),
      services,
    ),
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${c2.handoff_id}/approve`, { method: "POST", body: "{}" }),
    c2.handoff_id,
    services,
  );

  const res = handoffsListPendingRoute(
    new Request(`http://x/handoffs?status=pending,approved`),
    services,
  );
  const body = await readJsonAs<ListBody>(res);
  const ids = body.handoffs.map((h) => h.handoff_id).sort();
  expect(ids).toEqual([c1.handoff_id, c2.handoff_id].sort());
});

test("GET /handoffs without status param defaults to pending (back-compat)", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "a",
        to: "b",
        message: "m",
        conversation_id: "c1",
        triggered_by_event_id: "e1",
      }),
    }),
    services,
  );

  const res = handoffsListPendingRoute(new Request(`http://x/handoffs`), services);
  const body = await readJsonAs<ListBody>(res);
  expect(body.handoffs.length).toBe(1);
  expect(body.handoffs[0]!.status).toBe("pending");
});

test("GET /handoffs?status=garbage returns 400", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = handoffsListPendingRoute(new Request(`http://x/handoffs?status=garbage`), services);
  expect(res.status).toBe(400);
});

test("GET /handoffs?status=completed&since returns completed count since timestamp", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const insert = db.query(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, resolved_at)
    VALUES (?, ?, 'c1', 'a', 'b', 'm', 'completed', ?)
  `);
  insert.run("recent-resolved", "2026-04-25T18:00:00.000Z", "2026-04-25T19:30:00.000Z");
  insert.run("old-resolved", "2026-04-25T18:00:00.000Z", "2026-04-25T18:30:00.000Z");
  insert.run("legacy-recent", "2026-04-25T19:15:00.000Z", null);

  const res = handoffsListPendingRoute(
    new Request("http://x/handoffs?status=completed&since=2026-04-25T19%3A00%3A00.000Z"),
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<DoneBody>(res);
  expect(body).toEqual({ done: 2 });
});

async function seedApproveClaim(services: Services): Promise<string> {
  const create = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m",
          conversation_id: "c1",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    ),
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${create.handoff_id}/approve`, { method: "POST", body: "{}" }),
    create.handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(create.handoff_id, "test-worker");
  return create.handoff_id;
}

function seedLongLivedAgentAndTick(
  db: Database,
  opts: { agent_id: string; tick_id: string; chain_id?: string },
): void {
  reconcileLongLivedAgents(db, [makeLongLivedAgentConfig(opts.agent_id)], { now: 1 });
  db.query(
    "INSERT INTO long_lived_ticks (id, agent_id, chain_id, trigger_kind, started_at) VALUES (?, ?, ?, ?, ?)",
  ).run(opts.tick_id, opts.agent_id, opts.chain_id ?? `conv-${opts.tick_id}`, "manual", 1);
}

function seedLongLivedDispatchedHandoff(
  services: Services,
  opts: { handoff_id: string; agent_id: string; tick_id: string },
): string {
  services.handoffWriter.createApproved({
    handoff_id: opts.handoff_id,
    ts: "2026-04-25T20:00:00.000Z",
    project_id: null,
    conversation_id: `conv-${opts.handoff_id}`,
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    triggered_by_event_id: "e1",
    resolved_by: "machine-test",
    resolved_at: "2026-04-25T20:00:00.000Z",
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    dispatch_kind: "long_lived_tick",
    long_lived_agent_id: opts.agent_id,
    long_lived_tick_id: opts.tick_id,
    use_worktree: null,
    open_pr_on_review: null,
    parent_handoff_id: null,
    branch_base: null,
  });
  services.handoffWriter.claimDispatch(opts.handoff_id, "test-worker");
  return opts.handoff_id;
}

function seedDispatchCostRows(db: Database, conversation_id: string, costs: number[]): void {
  for (const [index, cost_usd] of costs.entries()) {
    db.query(
      `INSERT INTO agent_performance (
        performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type,
        outcome, rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd, tokens_used,
        latency_ms, source, notes, agent_kind, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `perf-${conversation_id}-${String(index + 1)}`,
      "2026-04-25T20:00:01.000Z",
      `handoff-${conversation_id}-${String(index + 1)}`,
      conversation_id,
      null,
      "worker-a",
      "implement_small",
      "merged",
      1,
      "y",
      null,
      5,
      cost_usd,
      null,
      null,
      "dispatch",
      null,
      null,
      "{}",
    );
  }
}

test("POST /handoffs/<id>/complete flips dispatched → completed", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const id = await seedApproveClaim(services);

  const res = await handoffsCompleteRoute(
    new Request("http://x", { method: "POST" }),
    id,
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<CompleteBody>(res);
  expect(body).toEqual({ handoff_id: id, status: "completed" });
  const row = db
    .query<{ status: string }, [string]>(`SELECT status FROM handoffs WHERE handoff_id=?`)
    .get(id);
  expect(row?.status).toBe("completed");
});

test("POST /handoffs/<id>/complete tears down long-lived tick as success", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  seedLongLivedAgentAndTick(db, { agent_id: "agent-1", tick_id: "tick-1", chain_id: "conv-1" });
  const id = seedLongLivedDispatchedHandoff(services, {
    handoff_id: "h-long-complete",
    agent_id: "agent-1",
    tick_id: "tick-1",
  });

  const res = await handoffsCompleteRoute(
    new Request("http://x", { method: "POST" }),
    id,
    services,
  );
  expect(res.status).toBe(200);

  const tick = db
    .query<{ outcome: string | null }, [string]>("SELECT outcome FROM long_lived_ticks WHERE id=?")
    .get("tick-1");
  expect(tick?.outcome).toBe("success");
});

test("POST /handoffs/<id>/complete stamps cost_cents from dispatch performance rows", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  seedLongLivedAgentAndTick(db, {
    agent_id: "agent-cost",
    tick_id: "tick-cost",
    chain_id: "conv-cost",
  });
  const id = seedLongLivedDispatchedHandoff(services, {
    handoff_id: "h-long-cost",
    agent_id: "agent-cost",
    tick_id: "tick-cost",
  });
  seedDispatchCostRows(db, "conv-cost", [0.012]);

  const res = await handoffsCompleteRoute(
    new Request("http://x", { method: "POST" }),
    id,
    services,
  );
  expect(res.status).toBe(200);

  const tick = db
    .query<
      { outcome: string | null; cost_cents: number | null },
      [string]
    >("SELECT outcome, cost_cents FROM long_lived_ticks WHERE id=?")
    .get("tick-cost");
  expect(tick).toEqual({
    outcome: "success",
    cost_cents: 1,
  });
});

test("POST /handoffs/<id>/fail leaves cost_cents null when dispatch performance rows are not ready yet", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  seedLongLivedAgentAndTick(db, {
    agent_id: "agent-race",
    tick_id: "tick-race",
    chain_id: "conv-race",
  });
  const id = seedLongLivedDispatchedHandoff(services, {
    handoff_id: "h-long-race",
    agent_id: "agent-race",
    tick_id: "tick-race",
  });

  const res = await handoffsFailRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ reason: "long-lived failure" }),
    }),
    id,
    services,
  );

  expect(res.status).toBe(200);
  const tick = db
    .query<
      { outcome: string | null; cost_cents: number | null },
      [string]
    >("SELECT outcome, cost_cents FROM long_lived_ticks WHERE id=?")
    .get("tick-race");
  expect(tick).toEqual({
    outcome: "failed",
    cost_cents: null,
  });
});

test("POST /handoffs/<id>/complete cancel path tears down long-lived tick as failed", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  seedLongLivedAgentAndTick(db, {
    agent_id: "agent-cancel",
    tick_id: "tick-cancel",
    chain_id: "conv-cancel",
  });
  const id = seedLongLivedDispatchedHandoff(services, {
    handoff_id: "h-long-cancel",
    agent_id: "agent-cancel",
    tick_id: "tick-cancel",
  });
  db.query("UPDATE handoffs SET cancel_requested_at=? WHERE handoff_id=?").run(
    "2026-04-25T20:01:00.000Z",
    id,
  );

  const res = await handoffsCompleteRoute(
    new Request("http://x", { method: "POST" }),
    id,
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<CompleteBody>(res);
  expect(body).toEqual({ handoff_id: id, status: "failed", reason: "cancelled" });

  const tick = db
    .query<
      { outcome: string | null; completed_at: number | null },
      [string]
    >("SELECT outcome, completed_at FROM long_lived_ticks WHERE id=?")
    .get("tick-cancel");
  expect(tick?.outcome).toBe("failed");
  expect(tick?.completed_at).not.toBeNull();
});

test("POST /handoffs/<id>/complete for non-long-lived handoff leaves long-lived ticks untouched", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  seedLongLivedAgentAndTick(db, { agent_id: "agent-2", tick_id: "tick-2", chain_id: "conv-2" });
  const id = await seedApproveClaim(services);

  const res = await handoffsCompleteRoute(
    new Request("http://x", { method: "POST" }),
    id,
    services,
  );
  expect(res.status).toBe(200);

  const tick = db
    .query<{ outcome: string | null }, [string]>("SELECT outcome FROM long_lived_ticks WHERE id=?")
    .get("tick-2");
  expect(tick?.outcome).toBeNull();
});

test("POST /handoffs/<id>/complete returns success when long-lived teardown throws", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  seedLongLivedAgentAndTick(db, {
    agent_id: "agent-throw",
    tick_id: "tick-throw",
    chain_id: "conv-throw",
  });
  const id = seedLongLivedDispatchedHandoff(services, {
    handoff_id: "h-long-throw",
    agent_id: "agent-throw",
    tick_id: "tick-throw",
  });

  const originalTransaction = db.transaction.bind(db);
  let injected = false;
  // db.transaction is a complex polymorphic call signature; bun-sqlite types
  // model it via an interface that lint cannot widen from our simpler stub
  // without a single documented assertion.
  db.transaction = ((fn: () => void): unknown =>
    originalTransaction(() => {
      fn();
      if (!injected) {
        injected = true;
        throw new Error("teardown boom");
      }
    })) as typeof db.transaction;

  const res = await handoffsCompleteRoute(
    new Request("http://x", { method: "POST" }),
    id,
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<CompleteBody>(res);
  expect(body).toEqual({ handoff_id: id, status: "completed" });

  const handoff = db
    .query<{ status: string }, [string]>("SELECT status FROM handoffs WHERE handoff_id=?")
    .get(id);
  expect(handoff?.status).toBe("completed");
});

test("POST /handoffs/<id>/complete on a pending handoff returns 409", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const create = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m",
          conversation_id: "c1",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    ),
  );

  const res = await handoffsCompleteRoute(
    new Request("http://x", { method: "POST" }),
    create.handoff_id,
    services,
  );
  expect(res.status).toBe(409);
});

test("POST /handoffs/<id>/complete on unknown id returns 404", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await handoffsCompleteRoute(
    new Request("http://x", { method: "POST" }),
    "h-nope",
    services,
  );
  expect(res.status).toBe(404);
});

async function seedAndApprove(services: Services): Promise<string> {
  const create = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m",
          conversation_id: "c1",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    ),
  );
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${create.handoff_id}/approve`, { method: "POST", body: "{}" }),
    create.handoff_id,
    services,
  );
  return create.handoff_id;
}

function makeFetcher(handler: (req: Request) => Promise<Response>): typeof fetch {
  // fetch's input parameter is the DOM RequestInfo type, which collapses to an
  // error-typed alias in the strict-lint pass. One documented cast at the
  // boundary keeps the helper type-safe internally.
  return ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req =
      typeof input === "string" || input instanceof URL ? new Request(input, init) : input;
    return handler(req);
  }) as typeof fetch;
}

function buildClaimTestServices(): { services: Services; db: Database } {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/handoffs-claim-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-25T20:00:00Z"),
    uuid: (): string => `e-${String(++n)}`,
  });
  return { services, db };
}

test("POST /handoffs/<id>/claim flips approved → dispatched and returns 200", async () => {
  const { services, db } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });
  const id = await seedAndApprove(services);
  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: TOKEN,
    worker_id: "test-worker",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request(`http://x/handoffs/${id}/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "test-worker" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<ClaimBody>(res);
  expect(body).toEqual({ handoff_id: id, status: "dispatched" });
  const row = db
    .query<{ status: string }, [string]>(`SELECT status FROM handoffs WHERE handoff_id=?`)
    .get(id);
  expect(row?.status).toBe("dispatched");
});

test("POST /handoffs/<id>/branch stores the created agent branch name", async () => {
  const { services, db } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });
  const id = await seedAndApprove(services);
  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: TOKEN,
    worker_id: "test-worker",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request(`http://x/handoffs/${id}/branch`, {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "test-worker", branch_name: `agent/${id}` }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<ClaimBody>(res);
  expect(body).toEqual({ handoff_id: id, branch_name: `agent/${id}` });

  const row = db
    .query<
      { branch_name: string | null },
      [string]
    >(`SELECT branch_name FROM handoffs WHERE handoff_id = ?`)
    .get(id);
  expect(row?.branch_name).toBe(`agent/${id}`);
});

test("POST /handoffs/<id>/claim a second time returns 409 with current_status", async () => {
  const { services } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });
  const id = await seedAndApprove(services);
  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: TOKEN,
    worker_id: "test-worker",
    fetcher: makeFetcher(fetchHandler),
  });
  const claimReq = (): Promise<Response> =>
    fetchHandler(
      new Request(`http://x/handoffs/${id}/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${worker_token}` },
        body: JSON.stringify({ worker_id: "test-worker" }),
      }),
    );

  await claimReq();
  const second = await claimReq();
  expect(second.status).toBe(409);
  const body = await readJsonAs<ClaimBody>(second);
  expect(body.current_status).toBe("dispatched");
});

test("POST /handoffs/<id>/claim on unknown id returns 404", async () => {
  const { services } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });
  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: TOKEN,
    worker_id: "test-worker",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request("http://x/handoffs/h-nope/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "test-worker" }),
    }),
  );
  expect(res.status).toBe(404);
});

test("POST /handoffs/<id>/claim on a pending handoff returns 409 (not approved)", async () => {
  const { services } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });
  const create = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m",
          conversation_id: "c1",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    ),
  );
  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: TOKEN,
    worker_id: "test-worker",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request(`http://x/handoffs/${create.handoff_id}/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "test-worker" }),
    }),
  );
  expect(res.status).toBe(409);
});

test("POST /handoffs/<id>/fail flips pending → failed", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const create = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m",
          conversation_id: "c1",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    ),
  );

  const res = await handoffsFailRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ reason: "testing failure" }),
    }),
    create.handoff_id,
    services,
  );

  expect(res.status).toBe(200);
  const body = await readJsonAs<FailBody>(res);
  expect(body).toEqual({ handoff_id: create.handoff_id, status: "failed" });

  const row = db
    .query<
      { status: string; resolution_reason: string | null },
      [string]
    >("SELECT status, resolution_reason FROM handoffs WHERE handoff_id=?")
    .get(create.handoff_id);
  expect(row?.status).toBe("failed");
  expect(row?.resolution_reason).toBe("testing failure");
});

test("POST /handoffs/<id>/fail tears down long-lived tick as failed", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  seedLongLivedAgentAndTick(db, { agent_id: "agent-3", tick_id: "tick-3" });
  const id = seedLongLivedDispatchedHandoff(services, {
    handoff_id: "h-long-fail",
    agent_id: "agent-3",
    tick_id: "tick-3",
  });

  const res = await handoffsFailRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ reason: "long-lived failure" }),
    }),
    id,
    services,
  );

  expect(res.status).toBe(200);
  const tick = db
    .query<{ outcome: string | null }, [string]>("SELECT outcome FROM long_lived_ticks WHERE id=?")
    .get("tick-3");
  expect(tick?.outcome).toBe("failed");
});

test("POST /handoffs/:id/approve reject path tears down long-lived tick as failed", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  seedLongLivedAgentAndTick(db, { agent_id: "agent-reject", tick_id: "tick-reject" });
  const create = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m",
          conversation_id: "c-reject",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    ),
  );
  db.query(
    "UPDATE handoffs SET dispatch_kind=?, long_lived_agent_id=?, long_lived_tick_id=? WHERE handoff_id=?",
  ).run("long_lived_tick", "agent-reject", "tick-reject", create.handoff_id);

  const res = await handoffsApproveRoute(
    new Request(`http://x/handoffs/${create.handoff_id}/approve`, {
      method: "POST",
      body: JSON.stringify({ reject: true, reason: "nope", resolved_by: "operator-1" }),
    }),
    create.handoff_id,
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<ApproveBody>(res);
  expect(body).toEqual({ handoff_id: create.handoff_id, status: "rejected" });

  const tick = db
    .query<
      { outcome: string | null; completed_at: number | null },
      [string]
    >("SELECT outcome, completed_at FROM long_lived_ticks WHERE id=?")
    .get("tick-reject");
  expect(tick?.outcome).toBe("failed");
  expect(tick?.completed_at).not.toBeNull();
});

test("POST /handoffs/<id>/fail returns 400 for missing/empty reason", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const res = await handoffsFailRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ reason: "" }),
    }),
    "some-id",
    services,
  );
  expect(res.status).toBe(400);

  const res2 = await handoffsFailRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({}),
    }),
    "some-id",
    services,
  );
  expect(res2.status).toBe(400);
});

test("POST /handoffs/<id>/fail returns 404 for unknown id", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const res = await handoffsFailRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ reason: "oops" }),
    }),
    "h-nope",
    services,
  );
  expect(res.status).toBe(404);
});

test("POST /handoffs/<id>/fail returns 409 if already terminal", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const id = await seedApproveClaim(services);
  await handoffsCompleteRoute(new Request("http://x", { method: "POST" }), id, services);

  const res = await handoffsFailRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ reason: "too late" }),
    }),
    id,
    services,
  );

  expect(res.status).toBe(409);
  const body = await readJsonAs<ClaimBody>(res);
  expect(body.current_status).toBe("completed");
});

test("GET /handoffs/<id> returns the handoff row", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const create = await readJsonAs<CreateBody>(
    await handoffsCreateRoute(
      new Request("http://x/handoffs", {
        method: "POST",
        body: JSON.stringify({
          from: "a",
          to: "b",
          message: "m",
          conversation_id: "c1",
          triggered_by_event_id: "e1",
        }),
      }),
      services,
    ),
  );

  const res = handoffsGetRoute(
    new Request(`http://x/handoffs/${create.handoff_id}`),
    create.handoff_id,
    services,
  );
  expect(res.status).toBe(200);
  const body = await readJsonAs<GetBody>(res);
  expect(body.handoff.handoff_id).toBe(create.handoff_id);
  expect(body.handoff.status).toBe("pending");
});

test("GET /handoffs/<id> returns 404 for unknown id", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = handoffsGetRoute(new Request("http://x/handoffs/h-nope"), "h-nope", services);
  expect(res.status).toBe(404);
  const body = await readJsonAs<GetErrorBody>(res);
  expect(body.error.code).toBe("not_found");
});

// GH #118 — ?since= offset normalization
test("GET /handoffs?status=completed&since= returns same count for UTC and offset-equivalent timestamps", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  // clock() → '2026-04-25T20:00:00.000Z'; insert a completed handoff directly
  db.run(
    `INSERT INTO handoffs
       (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, message, status)
     VALUES (?, ?, NULL, 'conv-since', 'a', 'b', 'msg', 'completed')`,
    ["h-since-1", "2026-04-25T20:00:00.000Z"],
  );

  // 1 minute before the handoff — expressed as plain UTC
  const resUtc = handoffsListPendingRoute(
    new Request("http://x/handoffs?status=completed&since=2026-04-25T19%3A59%3A00Z"),
    services,
  );
  expect(resUtc.status).toBe(200);
  const utcBody = await readJsonAs<DoneBody>(resUtc);

  // Same instant expressed with a +05:00 offset (string form looks like a later date)
  const resOffset = handoffsListPendingRoute(
    new Request("http://x/handoffs?status=completed&since=2026-04-26T00%3A59%3A00%2B05%3A00"),
    services,
  );
  expect(resOffset.status).toBe(200);
  const offsetBody = await readJsonAs<DoneBody>(resOffset);

  expect(utcBody.done).toBe(1);
  expect(offsetBody.done).toBe(utcBody.done);
});
