import type { AgentDescriptor, ChainStartRequest } from "@penumbra/core";

import {
  loadSqliteVec,
  MaestroSessionWriter,
  migrate,
  TaskEventBus,
  TaskWriter,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { afterEach, expect, mock, test } from "bun:test";

import { createOrchestrateReactor } from "../../src/reactors/orchestrate-reactor.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // setCustomSQLite is best-effort; tests fall back to bundled sqlite.
}

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

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

afterEach(() => {
  mock.restore();
  return Bun.sleep(5);
});

test("orchestrate reactor forwards task.project_id into chainStart", async () => {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name): AgentDescriptor | undefined =>
      name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined,
  });
  // project_id was once added by the test; it's now part of the base schema.
  // Keep the ALTER for legacy DBs but make it idempotent.
  const hasProjectId = db
    .query<{ name: string }, []>("PRAGMA table_info('tasks')")
    .all()
    .some((row) => row.name === "project_id");
  if (!hasProjectId) {
    db.run("ALTER TABLE tasks ADD COLUMN project_id TEXT");
  }

  const chainStartCalls: ChainStartRequest[] = [];
  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: (req) => {
      chainStartCalls.push(req);
      return Promise.resolve({ handoff_id: "handoff-1", conversation_id: "conv-1" });
    },
    resolveAgent: (name): AgentDescriptor | undefined =>
      name === MAESTRO_AGENT.name ? MAESTRO_AGENT : undefined,
    defaults: DEFAULT_BOUNDS,
  });
  reactor.start();

  const task_id = "task_cross_project";
  const now = Date.now();
  db.run(
    `INSERT INTO tasks (
      id, created_at, updated_at, created_by_kind, created_by_id,
      project_id, parent_task_id, kind, priority, prompt, acceptance_criteria,
      expected_artifacts, eligibility, review_eligibility, requires_review,
      bounds_wall_clock_ms, bounds_cost_cents, bounds_max_sub_dispatches, bounds_started_at,
      status, result_summary, result_artifacts, failure_reason, chain_id, origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'orchestrate', 'normal', ?, NULL, NULL, ?, NULL, 0, NULL, NULL, NULL, NULL, 'pending', NULL, NULL, NULL, NULL, NULL)`,
    [
      task_id,
      now,
      now,
      "human",
      "cli",
      "sirius",
      null,
      "Ship task 3.2",
      JSON.stringify({ allow_agents: [MAESTRO_AGENT.name] }),
    ],
  );
  bus.publish({
    task_id,
    at: now,
    kind: "filed",
    actor: "cli",
    payload: null,
  });

  await Bun.sleep(100);

  expect(chainStartCalls).toHaveLength(1);
  expect(chainStartCalls[0]).toMatchObject({
    initial_agent: MAESTRO_AGENT.name,
    project_id: "sirius",
    task_type: "implement_substantial",
  });

  const session = sessions.get(task_id);
  expect(session).toBeTruthy();

  reactor.stop();
  db.close();
});
