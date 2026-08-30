import {
  AgentTaskTypeSchema,
  buildServices,
  loadSqliteVec,
  migrate,
  ProjectRegistry,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { createDaemonFetchHandler } from "@src/serve.js";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* ignored: best-effort darwin sqlite hint */
}

const noop = (): void => undefined;

// File-local widening: tests stub agentchatConfig and workflowRegistry with
// shapes that intentionally exceed the strict daemon schema (extra
// maestro-only fields like maestro_capable, task_types, task_types_supported).
// A single documented widening at the seam keeps call sites typed.
function partialAs<T>(value: Partial<T>): T {
  return value as unknown as T;
}

interface TestAgentchatAgent {
  name: string;
  adapter?: string;
  options?: Record<string, unknown>;
  roles?: string[];
  maestro_capable?: boolean;
  task_types?: string[];
  task_types_supported?: string[];
}
interface TestAgentchatConfig {
  agents: TestAgentchatAgent[];
  default_roles?: Record<string, unknown>;
}
function setAgentchatConfig(services: Services, config: TestAgentchatConfig): void {
  // Test fixtures inject agent shapes (maestro_capable, task_types) outside
  // the strict daemon agentchatConfig schema. Object.assign widens at runtime
  // without changing the static Services type at call sites.
  Object.assign(services, { agentchatConfig: config });
}

interface TestWorkflowRegistry {
  list: () => { name: string; description: string; triggers: { kind: string }[] }[];
  errors: { path: string; error: string }[];
}
function setWorkflowRegistry(services: Services, registry: TestWorkflowRegistry): void {
  Object.assign(services, { workflowRegistry: registry });
}

function startTestDaemon(): {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  services: Services;
  token: string;
  mainRepoDir: string;
  stop: () => void;
} {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const root = mkdtempSync(join(tmpdir(), "maestro-route-"));
  const worktreeRootDir = join(root, "worktrees");
  const mainRepoDir = join(root, "main");
  mkdirSync(worktreeRootDir, { recursive: true });
  mkdirSync(mainRepoDir, { recursive: true });

  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-23T12:00:00.000Z"),
    worktreeRootDir,
    mainRepoDir,
  });
  services.watchdog = {
    recordHeartbeat: noop,
    hasActiveWorker: (): boolean => true,
    getStaleWorkers: (): string[] => [],
    getStaleHeartbeatAges: (): { worker_id: string; last_seen_age_ms: number }[] => [],
    tick: (): Promise<void> => Promise.resolve(),
  };
  Object.assign(services, { mainRepoDir });
  const token = "tok";
  const handler = createDaemonFetchHandler({ services, token });
  return {
    fetch: (path: string, init?: RequestInit): Promise<Response> =>
      handler(new Request(`http://x${path}`, init)),
    services,
    token,
    mainRepoDir,
    stop: (): void => {
      try {
        services.supervisor.stopAll();
      } catch {
        /* ignored: best-effort teardown */
      }
      try {
        db.close();
      } catch {
        /* ignored: best-effort teardown */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function authHeaders(token: string, headers: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...headers,
  };
}

function insertTask(
  daemon: ReturnType<typeof startTestDaemon>,
  input: { id: string; chain_id: string | null },
): void {
  daemon.services.db
    .query(
      `INSERT INTO tasks (
        id, created_at, updated_at, created_by_kind, created_by_id,
        kind, priority, prompt, eligibility, requires_review, status, chain_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      1_776_945_600_000,
      1_776_945_600_000,
      "human",
      "cli",
      "orchestrate",
      "normal",
      "seed task",
      JSON.stringify({ allow_agents: ["codex-acp-fast"] }),
      0,
      "pending",
      input.chain_id,
    );
}

function insertHandoff(
  daemon: ReturnType<typeof startTestDaemon>,
  input: { handoff_id: string; conversation_id: string },
): void {
  daemon.services.db
    .query(
      `INSERT INTO handoffs (
        handoff_id, ts, conversation_id, from_agent, to_agent, message, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.handoff_id,
      "2026-05-11T00:00:00.000Z",
      input.conversation_id,
      "maestro",
      "codex-acp-fast",
      "seed handoff",
      "approved",
    );
}

function setMaestroAgents(
  daemon: ReturnType<typeof startTestDaemon>,
  agents: {
    name: string;
    maestro_capable?: boolean;
    task_types?: string[];
    task_types_supported?: string[];
  }[],
): void {
  setAgentchatConfig(daemon.services, {
    agents: agents.map((agent) => ({ adapter: "noop", options: {}, roles: [], ...agent })),
    default_roles: {},
  });
  daemon.services.agentRegistry = agents.map((agent) => agent.name);
}

interface SessionPayload {
  task_id: string;
  chain_handoff_id: string | null;
  agent_id: string;
  started_at: number;
  wall_clock_budget_ms: number;
  cost_budget_cents: number;
  sub_dispatch_budget: number;
  cost_consumed_cents: number;
  sub_dispatches_consumed: number;
  soft_warned_at: number | null;
  terminated_at: number | null;
  termination_reason: string | null;
}

interface ValidationErrorBody {
  error: { code: string; field_errors: { path: string[] }[] };
}

test("GET /maestro/sessions/:task_id returns the hydrated record", async () => {
  const daemon = startTestDaemon();
  try {
    insertTask(daemon, { id: "task-1", chain_id: "conv-1" });
    insertHandoff(daemon, { handoff_id: "handoff-1", conversation_id: "conv-1" });
    daemon.services.db
      .query(
        `INSERT INTO maestro_sessions (
        task_id, chain_handoff_id, agent_id, started_at,
        wall_clock_budget_ms, cost_budget_cents, sub_dispatch_budget,
        cost_consumed_cents, sub_dispatches_consumed, soft_warned_at,
        terminated_at, termination_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "task-1",
        "handoff-1",
        "codex",
        1_746_000_000_000,
        120_000,
        80,
        3,
        12,
        1,
        null,
        null,
        null,
      );

    const res = await daemon.fetch("/maestro/sessions/task-1", {
      headers: authHeaders(daemon.token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionPayload;
    expect(body).toEqual({
      task_id: "task-1",
      chain_handoff_id: "handoff-1",
      agent_id: "codex",
      started_at: 1_746_000_000_000,
      wall_clock_budget_ms: 120_000,
      cost_budget_cents: 80,
      sub_dispatch_budget: 3,
      cost_consumed_cents: 12,
      sub_dispatches_consumed: 1,
      soft_warned_at: null,
      terminated_at: null,
      termination_reason: null,
    });
  } finally {
    daemon.stop();
  }
});

test("GET /maestro/sessions/:task_id returns 404 for unknown task_id", async () => {
  const daemon = startTestDaemon();
  try {
    const res = await daemon.fetch("/maestro/sessions/unknown-id", {
      headers: authHeaders(daemon.token),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body).toEqual({
      error: {
        code: "not_found",
        message: "maestro session unknown-id not found",
      },
    });
  } finally {
    daemon.stop();
  }
});

test("GET /maestro/sessions/:task_id requires bearer auth", async () => {
  const daemon = startTestDaemon();
  try {
    const missing = await daemon.fetch("/maestro/sessions/task-1");
    expect(missing.status).toBe(401);

    const wrong = await daemon.fetch("/maestro/sessions/task-1", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(wrong.status).toBe(401);
  } finally {
    daemon.stop();
  }
});

test("GET /maestro/capabilities returns canonical agents, task_types, and workflows", async () => {
  const daemon = startTestDaemon();
  try {
    setAgentchatConfig(daemon.services, {
      agents: [
        {
          name: "claude-acp-sonnet",
          adapter: "noop",
          options: {},
          roles: [],
          maestro_capable: true,
          task_types: ["plan_refine", "implement_substantial"],
        },
        {
          name: "codex-acp-fast",
          adapter: "noop",
          options: {},
          roles: [],
          maestro_capable: false,
          task_types_supported: ["debug_diagnose", "bogus_type"],
        },
        {
          name: "_internal-shadow",
          adapter: "noop",
          options: {},
          roles: [],
          maestro_capable: true,
        },
        { name: "gemini-missing", adapter: "noop", options: {}, roles: [], maestro_capable: true },
      ],
      default_roles: {},
    });
    daemon.services.agentRegistry = ["claude-acp-sonnet", "codex-acp-fast", "gemini-missing"];
    setWorkflowRegistry(daemon.services, {
      list: () => [
        { name: "brainstorm", description: "Brainstorm", triggers: [{ kind: "manual" }] },
        { name: "handoff", description: "Handoff", triggers: [{ kind: "manual" }] },
      ],
      errors: [],
    });

    const res = await daemon.fetch("/maestro/capabilities", {
      headers: authHeaders(daemon.token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: { name: string; task_types?: string[]; maestro_capable: boolean }[];
      task_types: string[];
      workflows: string[];
    };
    expect(body.agents).toEqual([
      {
        name: "claude-acp-sonnet",
        task_types: ["plan_refine", "implement_substantial"],
        maestro_capable: true,
      },
      {
        name: "codex-acp-fast",
        task_types: ["debug_diagnose"],
        maestro_capable: false,
      },
      {
        name: "gemini-missing",
        maestro_capable: true,
      },
    ]);
    expect(body.task_types).toEqual([...AgentTaskTypeSchema.options]);
    expect(body.workflows).toEqual(["brainstorm", "handoff"]);
  } finally {
    daemon.stop();
  }
});

test("POST /maestro/sessions creates a session and returns 201", async () => {
  const daemon = startTestDaemon();
  try {
    setMaestroAgents(daemon, [{ name: "codex-acp-fast", maestro_capable: true }]);
    insertTask(daemon, { id: "task-post-1", chain_id: "conv-post-1" });
    insertHandoff(daemon, { handoff_id: "handoff-post-1", conversation_id: "conv-post-1" });
    const res = await daemon.fetch("/maestro/sessions", {
      method: "POST",
      headers: authHeaders(daemon.token, { "content-type": "application/json" }),
      body: JSON.stringify({
        task_id: "task-post-1",
        chain_handoff_id: "handoff-post-1",
        agent_id: "codex-acp-fast",
        wall_clock_budget_ms: 60_000,
        cost_budget_cents: 150,
        sub_dispatch_budget: 4,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SessionPayload;
    expect(body).toEqual({
      task_id: "task-post-1",
      chain_handoff_id: "handoff-post-1",
      agent_id: "codex-acp-fast",
      started_at: 1_776_945_600_000,
      wall_clock_budget_ms: 60_000,
      cost_budget_cents: 150,
      sub_dispatch_budget: 4,
      cost_consumed_cents: 0,
      sub_dispatches_consumed: 0,
      soft_warned_at: null,
      terminated_at: null,
      termination_reason: null,
    });
  } finally {
    daemon.stop();
  }
});

test("POST /maestro/sessions accepts missing chain_handoff_id and persists null", async () => {
  const daemon = startTestDaemon();
  try {
    setMaestroAgents(daemon, [{ name: "codex-acp-fast", maestro_capable: true }]);
    insertTask(daemon, { id: "task-post-null-chain", chain_id: null });
    const res = await daemon.fetch("/maestro/sessions", {
      method: "POST",
      headers: authHeaders(daemon.token, { "content-type": "application/json" }),
      body: JSON.stringify({
        task_id: "task-post-null-chain",
        agent_id: "codex-acp-fast",
        wall_clock_budget_ms: 60_000,
        cost_budget_cents: 150,
        sub_dispatch_budget: 4,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SessionPayload;
    expect(body).toEqual({
      task_id: "task-post-null-chain",
      chain_handoff_id: null,
      agent_id: "codex-acp-fast",
      started_at: 1_776_945_600_000,
      wall_clock_budget_ms: 60_000,
      cost_budget_cents: 150,
      sub_dispatch_budget: 4,
      cost_consumed_cents: 0,
      sub_dispatches_consumed: 0,
      soft_warned_at: null,
      terminated_at: null,
      termination_reason: null,
    });
  } finally {
    daemon.stop();
  }
});

test("POST /maestro/sessions returns 409 with existing row when task session already exists", async () => {
  const daemon = startTestDaemon();
  try {
    setMaestroAgents(daemon, [{ name: "claude-acp-sonnet", maestro_capable: true }]);
    insertTask(daemon, { id: "task-dup-1", chain_id: "conv-dup-1" });
    insertHandoff(daemon, { handoff_id: "handoff-dup-1", conversation_id: "conv-dup-1" });
    daemon.services.db
      .query(
        `INSERT INTO maestro_sessions (
        task_id, chain_handoff_id, agent_id, started_at,
        wall_clock_budget_ms, cost_budget_cents, sub_dispatch_budget,
        cost_consumed_cents, sub_dispatches_consumed, soft_warned_at,
        terminated_at, termination_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "task-dup-1",
        "handoff-dup-1",
        "claude-acp-sonnet",
        1_746_000_000_000,
        120_000,
        80,
        3,
        12,
        1,
        null,
        null,
        null,
      );

    const res = await daemon.fetch("/maestro/sessions", {
      method: "POST",
      headers: authHeaders(daemon.token, { "content-type": "application/json" }),
      body: JSON.stringify({
        task_id: "task-dup-1",
        chain_handoff_id: "handoff-dup-1",
        agent_id: "claude-acp-sonnet",
        wall_clock_budget_ms: 10_000,
        cost_budget_cents: 10,
        sub_dispatch_budget: 1,
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; message: string };
      session: SessionPayload;
    };
    expect(body).toEqual({
      error: {
        code: "already_exists",
        message: "maestro session already exists for task task-dup-1",
      },
      session: {
        task_id: "task-dup-1",
        chain_handoff_id: "handoff-dup-1",
        agent_id: "claude-acp-sonnet",
        started_at: 1_746_000_000_000,
        wall_clock_budget_ms: 120_000,
        cost_budget_cents: 80,
        sub_dispatch_budget: 3,
        cost_consumed_cents: 12,
        sub_dispatches_consumed: 1,
        soft_warned_at: null,
        terminated_at: null,
        termination_reason: null,
      },
    });
  } finally {
    daemon.stop();
  }
});

test("POST /maestro/sessions returns 404 not_found.task for unknown task_id", async () => {
  const daemon = startTestDaemon();
  try {
    setMaestroAgents(daemon, [{ name: "codex-acp-fast", maestro_capable: true }]);
    insertHandoff(daemon, {
      handoff_id: "handoff-post-404-task",
      conversation_id: "conv-post-404-task",
    });
    const res = await daemon.fetch("/maestro/sessions", {
      method: "POST",
      headers: authHeaders(daemon.token, { "content-type": "application/json" }),
      body: JSON.stringify({
        task_id: "missing-task",
        chain_handoff_id: "handoff-post-404-task",
        agent_id: "codex-acp-fast",
        wall_clock_budget_ms: 60_000,
        cost_budget_cents: 150,
        sub_dispatch_budget: 4,
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body).toEqual({
      error: {
        code: "not_found.task",
        message: "task missing-task not found",
      },
    });
  } finally {
    daemon.stop();
  }
});

test("POST /maestro/sessions returns 404 not_found.handoff for unknown chain_handoff_id", async () => {
  const daemon = startTestDaemon();
  try {
    setMaestroAgents(daemon, [{ name: "codex-acp-fast", maestro_capable: true }]);
    insertTask(daemon, { id: "task-post-missing-handoff", chain_id: "conv-post-missing-handoff" });
    const res = await daemon.fetch("/maestro/sessions", {
      method: "POST",
      headers: authHeaders(daemon.token, { "content-type": "application/json" }),
      body: JSON.stringify({
        task_id: "task-post-missing-handoff",
        chain_handoff_id: "missing-handoff",
        agent_id: "codex-acp-fast",
        wall_clock_budget_ms: 60_000,
        cost_budget_cents: 150,
        sub_dispatch_budget: 4,
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body).toEqual({
      error: {
        code: "not_found.handoff",
        message: "handoff missing-handoff not found",
      },
    });
  } finally {
    daemon.stop();
  }
});

test("POST /maestro/sessions returns 422 handoff_task_mismatch when chain does not belong to task", async () => {
  const daemon = startTestDaemon();
  try {
    setMaestroAgents(daemon, [{ name: "codex-acp-fast", maestro_capable: true }]);
    insertTask(daemon, { id: "task-post-mismatch", chain_id: "conv-task-a" });
    insertHandoff(daemon, { handoff_id: "handoff-post-mismatch", conversation_id: "conv-task-b" });
    const res = await daemon.fetch("/maestro/sessions", {
      method: "POST",
      headers: authHeaders(daemon.token, { "content-type": "application/json" }),
      body: JSON.stringify({
        task_id: "task-post-mismatch",
        chain_handoff_id: "handoff-post-mismatch",
        agent_id: "codex-acp-fast",
        wall_clock_budget_ms: 60_000,
        cost_budget_cents: 150,
        sub_dispatch_budget: 4,
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body).toEqual({
      error: {
        code: "handoff_task_mismatch",
        message: "handoff handoff-post-mismatch does not belong to task task-post-mismatch",
      },
    });
  } finally {
    daemon.stop();
  }
});

test("POST /maestro/sessions returns 404 not_found.agent when agent is unknown", async () => {
  const daemon = startTestDaemon();
  try {
    setMaestroAgents(daemon, [{ name: "codex-acp-fast", maestro_capable: true }]);
    insertTask(daemon, { id: "task-post-agent-missing", chain_id: "conv-post-agent-missing" });
    insertHandoff(daemon, {
      handoff_id: "handoff-post-agent-missing",
      conversation_id: "conv-post-agent-missing",
    });
    const res = await daemon.fetch("/maestro/sessions", {
      method: "POST",
      headers: authHeaders(daemon.token, { "content-type": "application/json" }),
      body: JSON.stringify({
        task_id: "task-post-agent-missing",
        chain_handoff_id: "handoff-post-agent-missing",
        agent_id: "ghost-agent",
        wall_clock_budget_ms: 60_000,
        cost_budget_cents: 150,
        sub_dispatch_budget: 4,
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body).toEqual({
      error: {
        code: "not_found.agent",
        message: "agent ghost-agent not found",
      },
    });
  } finally {
    daemon.stop();
  }
});

test("POST /maestro/sessions returns 422 agent_not_maestro_capable when agent is not marked maestro_capable", async () => {
  const daemon = startTestDaemon();
  try {
    setMaestroAgents(daemon, [{ name: "codex-acp-fast", maestro_capable: false }]);
    insertTask(daemon, {
      id: "task-post-agent-not-maestro",
      chain_id: "conv-post-agent-not-maestro",
    });
    insertHandoff(daemon, {
      handoff_id: "handoff-post-agent-not-maestro",
      conversation_id: "conv-post-agent-not-maestro",
    });
    const res = await daemon.fetch("/maestro/sessions", {
      method: "POST",
      headers: authHeaders(daemon.token, { "content-type": "application/json" }),
      body: JSON.stringify({
        task_id: "task-post-agent-not-maestro",
        chain_handoff_id: "handoff-post-agent-not-maestro",
        agent_id: "codex-acp-fast",
        wall_clock_budget_ms: 60_000,
        cost_budget_cents: 150,
        sub_dispatch_budget: 4,
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body).toEqual({
      error: {
        code: "agent_not_maestro_capable",
        message: "agent codex-acp-fast must set maestro_capable: true",
      },
    });
  } finally {
    daemon.stop();
  }
});

test("POST /maestro/sessions validates budgets as positive integers", async () => {
  const daemon = startTestDaemon();
  try {
    setMaestroAgents(daemon, [{ name: "codex-acp-fast", maestro_capable: true }]);
    insertTask(daemon, {
      id: "task-post-budget-validation",
      chain_id: "conv-post-budget-validation",
    });
    insertHandoff(daemon, {
      handoff_id: "handoff-post-budget-validation",
      conversation_id: "conv-post-budget-validation",
    });
    const zeroCost = await daemon.fetch("/maestro/sessions", {
      method: "POST",
      headers: authHeaders(daemon.token, { "content-type": "application/json" }),
      body: JSON.stringify({
        task_id: "task-post-budget-validation",
        chain_handoff_id: "handoff-post-budget-validation",
        agent_id: "codex-acp-fast",
        wall_clock_budget_ms: 60_000,
        cost_budget_cents: 0,
        sub_dispatch_budget: 4,
      }),
    });
    expect(zeroCost.status).toBe(400);
    const zeroCostBody = (await zeroCost.json()) as ValidationErrorBody;
    expect(zeroCostBody.error.code).toBe("validation_error");
    expect(
      zeroCostBody.error.field_errors.some((entry) => entry.path.join(".") === "cost_budget_cents"),
    ).toBe(true);

    const negativeSubDispatch = await daemon.fetch("/maestro/sessions", {
      method: "POST",
      headers: authHeaders(daemon.token, { "content-type": "application/json" }),
      body: JSON.stringify({
        task_id: "task-post-budget-validation",
        chain_handoff_id: "handoff-post-budget-validation",
        agent_id: "codex-acp-fast",
        wall_clock_budget_ms: 60_000,
        cost_budget_cents: 120,
        sub_dispatch_budget: -1,
      }),
    });
    expect(negativeSubDispatch.status).toBe(400);
    const negativeSubDispatchBody = (await negativeSubDispatch.json()) as ValidationErrorBody;
    expect(negativeSubDispatchBody.error.code).toBe("validation_error");
    expect(
      negativeSubDispatchBody.error.field_errors.some(
        (entry) => entry.path.join(".") === "sub_dispatch_budget",
      ),
    ).toBe(true);
  } finally {
    daemon.stop();
  }
});

test("POST /maestro/sessions/adhoc files and dispatches an orchestrate task", async () => {
  const daemon = startTestDaemon();
  try {
    setMaestroAgents(daemon, [{ name: "claude-acp-sonnet", maestro_capable: true }]);
    const res = await daemon.fetch("/maestro/sessions/adhoc", {
      method: "POST",
      headers: authHeaders(daemon.token, { "content-type": "application/json" }),
      body: JSON.stringify({
        message: "summarize the recent git log into a 3-line release note",
        agent_id: "claude-acp-sonnet",
        wall_clock_budget_ms: 600_000,
        cost_budget_cents: 50,
        sub_dispatch_budget: 5,
        project_id: "proj-alpha",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      status: string;
      session: {
        task_id: string;
        chain_handoff_id: string | null;
        agent_id: string;
        wall_clock_budget_ms: number;
        cost_budget_cents: number;
        sub_dispatch_budget: number;
      };
      agent_name: string;
      chain_handoff_id: string;
      conversation_id: string;
    };
    expect(body.status).toBe("dispatched");
    expect(body.agent_name).toBe("claude-acp-sonnet");
    expect(body.session.agent_id).toBe("claude-acp-sonnet");
    expect(body.session.wall_clock_budget_ms).toBe(600_000);
    expect(body.session.cost_budget_cents).toBe(50);
    expect(body.session.sub_dispatch_budget).toBe(5);
    expect(body.session.chain_handoff_id).toBe(body.chain_handoff_id);
    expect(body.session.task_id).toMatch(/^task_/);

    const task = daemon.services.db
      .query<
        { prompt: string; project_id: string | null; kind: string; eligibility: string },
        [string]
      >("SELECT prompt, project_id, kind, eligibility FROM tasks WHERE id = ? LIMIT 1")
      .get(body.session.task_id);
    expect(task?.prompt).toBe("summarize the recent git log into a 3-line release note");
    expect(task?.project_id).toBe("proj-alpha");
    expect(task?.kind).toBe("orchestrate");
    const eligibility = JSON.parse(task?.eligibility ?? "{}") as { allow_agents?: string[] };
    expect(eligibility.allow_agents).toEqual(["claude-acp-sonnet"]);

    // The adhoc route must record orchestrate_spawned (carrying the chain
    // handoff id) so the orchestrate-reactor's chain-completion backstop covers
    // adhoc dispatches too — otherwise an adhoc dispatch that finishes without
    // self-completing hangs `leased` until the lease expires.
    const spawned = daemon.services.db
      .query<
        { payload_json: string | null },
        [string]
      >("SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_spawned' ORDER BY id DESC LIMIT 1")
      .get(body.session.task_id);
    expect(spawned).toBeTruthy();
    const spawnPayload = JSON.parse(spawned?.payload_json ?? "{}") as { chain_handoff_id?: string };
    expect(spawnPayload.chain_handoff_id).toBe(body.chain_handoff_id);
  } finally {
    daemon.stop();
  }
});

test("POST /maestro/sessions/adhoc validates required fields", async () => {
  const daemon = startTestDaemon();
  try {
    const res = await daemon.fetch("/maestro/sessions/adhoc", {
      method: "POST",
      headers: authHeaders(daemon.token, { "content-type": "application/json" }),
      body: JSON.stringify({
        message: "",
        agent_id: "claude-acp-sonnet",
        wall_clock_budget_ms: 0,
        cost_budget_cents: 0,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ValidationErrorBody;
    expect(body.error.code).toBe("validation_error");
    const errorPaths = body.error.field_errors.map((entry) => entry.path.join("."));
    expect(errorPaths).toContain("message");
    expect(errorPaths).toContain("wall_clock_budget_ms");
    expect(errorPaths).toContain("cost_budget_cents");
    expect(errorPaths).toContain("sub_dispatch_budget");
  } finally {
    daemon.stop();
  }
});

test("POST /maestro/sessions/adhoc resolves project_id from mainRepoDir when registered", async () => {
  const daemon = startTestDaemon();
  try {
    const projectId = "proj-registered";
    const mainRepoDir = daemon.mainRepoDir;
    daemon.services.projectRegistry = new ProjectRegistry(
      new Map([[projectId, { project_id: projectId, root_path: mainRepoDir }]]),
    );
    setMaestroAgents(daemon, [{ name: "claude-acp-sonnet", maestro_capable: true }]);

    writeFileSync(join(mainRepoDir, ".penumbra-project"), `${projectId}\n`);

    const res = await daemon.fetch("/maestro/sessions/adhoc", {
      method: "POST",
      headers: authHeaders(daemon.token, { "content-type": "application/json" }),
      body: JSON.stringify({
        message: "summarize the recent git log into a 3-line release note",
        agent_id: "claude-acp-sonnet",
        wall_clock_budget_ms: 600_000,
        cost_budget_cents: 50,
        sub_dispatch_budget: 5,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      status: string;
      session: { task_id: string };
    };
    expect(body.status).toBe("dispatched");

    const task = daemon.services.db
      .query<{ project_id: string | null }>("SELECT project_id FROM tasks WHERE id = ? LIMIT 1")
      .get(body.session.task_id);
    expect(task?.project_id).toBe(projectId);
  } finally {
    daemon.stop();
  }
});

test("POST /maestro/sessions/adhoc rejects no_match scope when PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID=true", async () => {
  const daemon = startTestDaemon();
  const previous = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  try {
    const projectId = "proj-unregistered";
    const mainRepoDir = daemon.mainRepoDir;
    daemon.services.projectRegistry = new ProjectRegistry(
      new Map([["other-proj", { project_id: "other-proj", root_path: "/tmp/other" }]]),
    );
    setMaestroAgents(daemon, [{ name: "claude-acp-sonnet", maestro_capable: true }]);

    writeFileSync(join(mainRepoDir, ".penumbra-project"), `${projectId}\n`);

    const res = await daemon.fetch("/maestro/sessions/adhoc", {
      method: "POST",
      headers: authHeaders(daemon.token, { "content-type": "application/json" }),
      body: JSON.stringify({
        message: "summarize the recent git log into a 3-line release note",
        agent_id: "claude-acp-sonnet",
        wall_clock_budget_ms: 600_000,
        cost_budget_cents: 50,
        sub_dispatch_budget: 5,
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; hint: string };
    };
    expect(body.error.code).toBe("project_id_required");
    expect(body.error.message).toContain(
      `project_id_required: resolved from daemon cwd as ${projectId}`,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    } else {
      process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = previous;
    }
    daemon.stop();
  }
});

test("POST /maestro/sessions/adhoc falls back when scope cannot be resolved but explicit project_id is omitted", async () => {
  const daemon = startTestDaemon();
  const previous = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  try {
    const mainRepoDir = daemon.mainRepoDir;
    // The route only invokes projectRegistry.list() in this branch; widen a
    // throwing stub at the test seam so we can simulate a registry outage.
    daemon.services.projectRegistry = partialAs<ProjectRegistry>({
      list: () => {
        throw new Error("registry unavailable");
      },
    });
    setMaestroAgents(daemon, [{ name: "claude-acp-sonnet", maestro_capable: true }]);

    writeFileSync(join(mainRepoDir, ".penumbra-project"), `registry-unavailable-proj\n`);

    const res = await daemon.fetch("/maestro/sessions/adhoc", {
      method: "POST",
      headers: authHeaders(daemon.token, { "content-type": "application/json" }),
      body: JSON.stringify({
        message: "summarize the recent git log into a 3-line release note",
        agent_id: "claude-acp-sonnet",
        wall_clock_budget_ms: 600_000,
        cost_budget_cents: 50,
        sub_dispatch_budget: 5,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string; session: { task_id: string } };
    expect(body.status).toBe("dispatched");

    const task = daemon.services.db
      .query<{ project_id: string | null }>("SELECT project_id FROM tasks WHERE id = ? LIMIT 1")
      .get(body.session.task_id);
    expect(task?.project_id).toBeNull();
  } finally {
    if (previous === undefined) {
      delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    } else {
      process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = previous;
    }
    daemon.stop();
  }
});
