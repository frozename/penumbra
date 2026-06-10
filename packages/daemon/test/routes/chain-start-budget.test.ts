import { beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  buildServices,
  loadSqliteVec,
  MaestroSessionWriter,
  migrate,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { chainsStartRoute } from "../../src/routes/chains.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {}
}

// strict-mode env can leak from a live maestro shell; clear it here so test fixtures stay deterministic
beforeAll(() => {
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
});

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/chain-start-budget-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-05T00:00:00Z"),
    uuid: () => `id-${++n}`,
    agentRegistry: ["planner"],
    worktreeRootDir: "/tmp/penumbra-chain-start-budget-worktrees",
    mainRepoDir: "/tmp/penumbra-chain-start-budget-main",
  });
  services.watchdog = {
    recordHeartbeat: () => {},
    hasActiveWorker: () => true,
    getStaleWorkers: () => [],
    getStaleHeartbeatAges: () => [],
    tick: async () => {},
  };
  return services;
}

function seedTask(db: Database, taskId: string): void {
  db.query<
    unknown,
    [
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
    ]
  >(
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
    "workflow",
    "test-suite",
    null,
    "orchestrate",
    "normal",
    "coordinate the run",
    null,
    null,
    "{}",
    null,
    0,
    null,
    null,
    null,
    null,
    "pending",
    null,
    null,
    null,
    null,
    null,
  );
}

test("POST /chains/start returns 429 BudgetExceeded when parent maestro session sub-dispatch budget is exhausted", async () => {
  const services = tempServices();
  const sessions = new MaestroSessionWriter({ db: services.db, now: () => 0 });
  seedTask(services.db, "task-budgeted");
  sessions.start({
    task_id: "task-budgeted",
    chain_handoff_id: "h-parent-budgeted",
    agent_id: "maestro",
    wall_clock_budget_ms: 60_000,
    cost_budget_cents: 100,
    sub_dispatch_budget: 1,
  });
  sessions.incrementSubDispatch("task-budgeted");

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "spawn child",
        parent_handoff_id: "h-parent-budgeted",
      }),
    }),
    services,
  );

  expect(res.status).toBe(429);
  expect(await res.json()).toEqual({
    error: "BudgetExceeded",
    axis: "sub_dispatches",
    limit: 1,
    observed: 1,
  });
});
