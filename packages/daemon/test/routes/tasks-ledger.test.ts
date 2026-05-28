import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildServices,
  loadSqliteVec,
  migrate,
  TaskCooldowns,
  TaskEventBus,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { createDaemonFetchHandler } from "../../src/serve.js";
import { createTaskLeaseSweeper } from "../../src/sweepers/task-leases.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

function startTestDaemon(startMs = Date.parse("2026-04-23T12:00:00.000Z")): {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  services: Services;
  token: string;
  taskEvents: TaskEventBus;
  setNowMs: (ms: number) => void;
  nowMs: () => number;
  stop: () => void;
} {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const root = mkdtempSync(join(tmpdir(), "tasks-ledger-route-"));
  const worktreeRootDir = join(root, "worktrees");
  const mainRepoDir = join(root, "main");
  mkdirSync(worktreeRootDir, { recursive: true });
  mkdirSync(mainRepoDir, { recursive: true });

  let nowMs = startMs;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date(nowMs),
    worktreeRootDir,
    mainRepoDir,
  });
  services.watchdog = {
    recordHeartbeat: () => {},
    hasActiveWorker: () => true,
    tick: async () => {},
  };

  (services as Services & { agentchatConfig?: any }).agentchatConfig = {
    agents: [
      { name: "codex", tags: ["typescript"], tier: "oc", cost_cents_per_run: 15 },
      { name: "gemini", tags: ["typescript"], tier: "premium", cost_cents_per_run: 15 },
    ],
  };

  const token = "tok";
  const taskEvents = new TaskEventBus();
  const handler = createDaemonFetchHandler({ services, token, taskEvents });

  return {
    fetch: (path, init) => handler(new Request(`http://x${path}`, init)),
    services,
    token,
    taskEvents,
    setNowMs: (ms: number) => {
      nowMs = ms;
    },
    nowMs: () => nowMs,
    stop: () => {
      try {
        services.supervisor.stopAll();
      } catch {}
      try {
        db.close();
      } catch {}
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function authHeaders(token: string, headers: HeadersInit = {}): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    ...headers,
  };
}

async function postJson(
  daemon: ReturnType<typeof startTestDaemon>,
  path: string,
  body: unknown,
  headers: HeadersInit = {},
): Promise<Response> {
  return daemon.fetch(path, {
    method: "POST",
    headers: authHeaders(daemon.token, {
      "content-type": "application/json",
      ...headers,
    }),
    body: JSON.stringify(body),
  });
}

async function fileTask(
  daemon: ReturnType<typeof startTestDaemon>,
  body: Record<string, unknown> = {},
): Promise<string> {
  const res = await postJson(daemon, "/tasks", {
    prompt: "implement route",
    created_by_kind: "human",
    created_by_id: "cli",
    ...body,
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { task_id: string };
  return json.task_id;
}

async function leaseTask(
  daemon: ReturnType<typeof startTestDaemon>,
  agentId: string,
): Promise<{ task_id: string; lease_id: string; expires_at: number }> {
  const res = await postJson(daemon, "/tasks/lease", { agent_id: agentId });
  expect(res.status).toBe(200);
  return (await res.json()) as { task_id: string; lease_id: string; expires_at: number };
}

async function waitForRowCount(
  daemon: ReturnType<typeof startTestDaemon>,
  expected: number,
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const row = daemon.services.db
      .query<{ n: number }>("SELECT COUNT(*) AS n FROM agent_performance")
      .get();
    if ((row?.n ?? 0) === expected) return;
    await Bun.sleep(10);
  }
  const row = daemon.services.db
    .query<{ n: number }>("SELECT COUNT(*) AS n FROM agent_performance")
    .get();
  expect(row?.n ?? 0).toBe(expected);
}

function readLedgerRows(daemon: ReturnType<typeof startTestDaemon>): Array<{
  agent_name: string;
  task_type: string;
  outcome: string;
  notes: string | null;
}> {
  return daemon.services.db
    .query<{
      agent_name: string;
      task_type: string;
      outcome: string;
      notes: string | null;
    }>(
      "SELECT agent_name, task_type, outcome, notes FROM agent_performance ORDER BY ts ASC, performance_id ASC",
    )
    .all();
}

test("producer success without review writes implement_small success row", async () => {
  const daemon = startTestDaemon();
  try {
    await fileTask(daemon);
    const lease = await leaseTask(daemon, "codex");
    const complete = await postJson(daemon, `/tasks/${lease.task_id}/complete`, {
      lease_id: lease.lease_id,
      result_summary: "done",
      result_artifacts: [{ type: "commit", ref: "abc123" }],
    });
    expect(complete.status).toBe(200);

    await waitForRowCount(daemon, 1);
    expect(readLedgerRows(daemon)).toEqual([
      {
        agent_name: "codex",
        task_type: "implement_small",
        outcome: "merged",
        notes: null,
      },
    ]);
  } finally {
    daemon.stop();
  }
});

test("producer success with review_passed writes doer + reviewer success rows", async () => {
  const daemon = startTestDaemon();
  try {
    const parentId = await fileTask(daemon, { requires_review: true });
    const doerLease = await leaseTask(daemon, "codex");
    expect(doerLease.task_id).toBe(parentId);

    const completed = await postJson(daemon, `/tasks/${parentId}/complete`, {
      lease_id: doerLease.lease_id,
      result_summary: "ready",
      result_artifacts: [{ type: "commit", ref: "abc123" }],
    });
    expect(completed.status).toBe(200);

    const child = daemon.services.db
      .query<
        { id: string },
        [string]
      >(`SELECT id FROM tasks WHERE parent_task_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(parentId);
    expect(child?.id).toBeTruthy();

    const reviewerLease = await leaseTask(daemon, "gemini");
    expect(reviewerLease.task_id).toBe(child!.id);

    const reviewComplete = await postJson(daemon, `/tasks/${child!.id}/complete`, {
      lease_id: reviewerLease.lease_id,
      result_summary: "reviewed",
      review_verdict: { passed: true, notes: "looks good" },
    });
    expect(reviewComplete.status).toBe(200);

    await waitForRowCount(daemon, 2);
    const rows = readLedgerRows(daemon);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { agent_name: "codex", task_type: "implement_small", outcome: "merged", notes: null },
        { agent_name: "gemini", task_type: "review_adversarial", outcome: "merged", notes: null },
      ]),
    );
  } finally {
    daemon.stop();
  }
});

test("review_failed writes producer failure and reviewer success", async () => {
  const daemon = startTestDaemon();
  try {
    const parentId = await fileTask(daemon, { requires_review: true });
    const doerLease = await leaseTask(daemon, "codex");

    const completed = await postJson(daemon, `/tasks/${parentId}/complete`, {
      lease_id: doerLease.lease_id,
      result_summary: "ready",
      result_artifacts: [{ type: "commit", ref: "abc123" }],
    });
    expect(completed.status).toBe(200);

    const child = daemon.services.db
      .query<
        { id: string },
        [string]
      >(`SELECT id FROM tasks WHERE parent_task_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(parentId);
    expect(child?.id).toBeTruthy();

    const reviewerLease = await leaseTask(daemon, "gemini");
    expect(reviewerLease.task_id).toBe(child!.id);

    const reviewComplete = await postJson(daemon, `/tasks/${child!.id}/complete`, {
      lease_id: reviewerLease.lease_id,
      result_summary: "reviewed",
      review_verdict: { passed: false, notes: "missing tests" },
    });
    expect(reviewComplete.status).toBe(200);

    await waitForRowCount(daemon, 2);
    const rows = readLedgerRows(daemon);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({
      agent_name: "codex",
      task_type: "implement_small",
      outcome: "failed",
      notes: "review rejected: missing tests",
    });
    expect(rows).toContainEqual({
      agent_name: "gemini",
      task_type: "review_adversarial",
      outcome: "merged",
      notes: null,
    });
  } finally {
    daemon.stop();
  }
});

test("lease expiration writes failure row with lease expired reason", async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon, {
      eligibility: { heartbeat_ttl_ms: 1_000 },
    });
    const lease = await leaseTask(daemon, "codex");
    expect(lease.task_id).toBe(taskId);

    const cooldowns = new TaskCooldowns();
    const sweeper = createTaskLeaseSweeper({
      db: daemon.services.db,
      now: daemon.nowMs,
      cooldowns,
      bus: daemon.taskEvents,
    });

    daemon.setNowMs(daemon.nowMs() + 1_100);
    sweeper.tick();

    await waitForRowCount(daemon, 1);
    expect(readLedgerRows(daemon)).toEqual([
      {
        agent_name: "codex",
        task_type: "implement_substantial",
        outcome: "failed",
        notes: "lease expired",
      },
    ]);
  } finally {
    daemon.stop();
  }
});

test("cancellation does not write a ledger row", async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const cancelled = await postJson(daemon, `/tasks/${taskId}/cancel`, {
      reason: "no longer needed",
    });
    expect(cancelled.status).toBe(200);

    await waitForRowCount(daemon, 0);
  } finally {
    daemon.stop();
  }
});
