import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker as NodeWorker } from "node:worker_threads";

import { migrate } from "@src/db/migrations.js";
import { applyRuntimePragmas, loadSqliteVec } from "@src/db/sqlite-vec.js";
import { pickPreferred as exportedPickPreferred } from "@src/index.js";
import type { RouteAgentOutput } from "@src/services/agent-routing.js";
import { pickPreferred } from "@src/tasks/auction.js";
import type { AgentDescriptor } from "@src/tasks/eligibility.js";
import type { FileTaskInput } from "@src/tasks/schema.js";
import { TaskWriter } from "@src/tasks/writer.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // already loaded
  }
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function freshDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-auction-race-"));
  const dbPath = join(dir, "race.sqlite");
  const db = new Database(dbPath);
  loadSqliteVec(db);
  applyRuntimePragmas(db);
  migrate(db, { embeddingDim: 384 });
  db.close();
  return dbPath;
}
const WRITER_URL = new URL("../../src/tasks/writer.js", import.meta.url).href;
const PRAGMAS_URL = new URL("../../src/db/sqlite-vec.js", import.meta.url).href;

// 16 worker threads are enough to exercise real SQLite lock contention while keeping the
// isolation cost low: the race test measured 130-168ms across focused runs, so 30s
// leaves broad-suite headroom without masking a genuine hang.
const RACE_TEST_TIMEOUT_MS = 30_000;
// Bounds the "wait for all N to signal ready" loop; must stay under RACE_TEST_TIMEOUT_MS
// with room left for release + the actual next() calls + assertions.
const RACE_BARRIER_READY_TIMEOUT_MS = 10_000;
// Self-audit: once released, all workers should call next() within a tight window of each
// other after a single Atomics.notify() release. A regression back to a staggered
// wall-clock start would blow this out to hundreds/thousands of ms, so this threshold must
// fail loudly if the barrier ever stops actually synchronizing the callers.
const RACE_BARRIER_SPREAD_THRESHOLD_MS = 2_000;
const RACE_CONCURRENCY = 16;

function baseInput(overrides: Partial<FileTaskInput> = {}): FileTaskInput {
  return {
    prompt: "implement auction behavior",
    created_by_kind: "human",
    created_by_id: "cli",
    ...overrides,
  };
}

type AgentRegistry = Map<string, AgentDescriptor>;

function defaultAgents(): AgentRegistry {
  return new Map<string, AgentDescriptor>([
    ["A", { name: "A", tags: ["core"], tier: "standard", cost_cents_per_run: 25 }],
    ["B", { name: "B", tags: ["core"], tier: "standard", cost_cents_per_run: 25 }],
    ["C", { name: "C", tags: ["core"], tier: "premium", cost_cents_per_run: 50 }],
  ]);
}

function raceRouteAgentOutput(): RouteAgentOutput {
  return {
    detail: "rank" as const,
    candidates: {
      task_type: "implement_substantial",
      window: { from: null, to: "" },
      candidates: [
        {
          agent_name: "A",
          samples: 1,
          successes: 1,
          failures: 0,
          neutral: 0,
          success_rate: 1,
          avg_rounds: null,
          avg_latency_ms: null,
          cost_per_success_usd: null,
          avg_reviewer_findings: null,
          avg_trust_score: null,
          score: 90,
          last_outcome_at: "",
        },
        {
          agent_name: "B",
          samples: 1,
          successes: 1,
          failures: 0,
          neutral: 0,
          success_rate: 1,
          avg_rounds: null,
          avg_latency_ms: null,
          cost_per_success_usd: null,
          avg_reviewer_findings: null,
          avg_trust_score: null,
          score: 30,
          last_outcome_at: "",
        },
      ],
    },
  };
}

describe("TaskWriter.next auction window", () => {
  let db: Database;
  let nowMs: number;
  let agents: AgentRegistry;

  beforeEach(() => {
    db = freshDb();
    nowMs = 0;
    agents = defaultAgents();
  });

  function makeWriter(rankings: { agent_name: string; score: number }[]): TaskWriter {
    return new TaskWriter(db, {
      now: (): number => nowMs,
      resolveAgent: (name): AgentDescriptor | undefined => agents.get(name),
      routeAgent: () => ({
        detail: "rank" as const,
        candidates: {
          task_type: "implement_substantial",
          window: { from: null, to: "" },
          candidates: rankings.map((r) => ({
            agent_name: r.agent_name,
            samples: 1,
            successes: 1,
            failures: 0,
            neutral: 0,
            success_rate: 1,
            avg_rounds: null,
            avg_latency_ms: null,
            cost_per_success_usd: null,
            avg_reviewer_findings: null,
            avg_trust_score: null,
            score: r.score,
            last_outcome_at: "",
          })),
        },
      }),
    });
  }

  test("inside window non-preferred agent is blocked; preferred agent leases", async () => {
    const writer = makeWriter([
      { agent_name: "A", score: 90 },
      { agent_name: "B", score: 30 },
    ]);
    const { task_id } = writer.file(baseInput());

    nowMs = 10_000;
    const bResult = await writer.next({ agent_id: "B" });
    expect(bResult).toBeNull();

    const aResult = await writer.next({ agent_id: "A" });
    expect(aResult).not.toBeNull();
    expect(aResult!.task_id).toBe(task_id);
    expect(aResult!.lease_id).toMatch(/^lease_[0-9a-f-]{36}$/);

    const afterLease = await writer.next({ agent_id: "B" });
    expect(afterLease).toBeNull();
  });

  test("after window expires, non-preferred eligible agent can lease FCFS", async () => {
    const writer = makeWriter([
      { agent_name: "A", score: 90 },
      { agent_name: "B", score: 30 },
    ]);
    const { task_id } = writer.file(baseInput());

    nowMs = 31_000;
    const leased = await writer.next({ agent_id: "B" });
    expect(leased).not.toBeNull();
    expect(leased!.task_id).toBe(task_id);
  });

  test("single eligible agent claims immediately", async () => {
    const writer = makeWriter([
      { agent_name: "A", score: 90 },
      { agent_name: "B", score: 30 },
    ]);
    writer.file(
      baseInput({
        eligibility: { allow_agents: ["A"] },
      }),
    );

    nowMs = 1_000;
    const leased = await writer.next({ agent_id: "A" });
    expect(leased).not.toBeNull();
    expect(leased!.task_id).toMatch(/^task_[0-9a-f-]{36}$/);
  });

  test("successful lease persists auction_score for the claiming agent", async () => {
    const writer = makeWriter([
      { agent_name: "A", score: 90 },
      { agent_name: "B", score: 30 },
    ]);
    const { task_id } = writer.file(baseInput());

    nowMs = 10_000;
    const leased = await writer.next({ agent_id: "A" });
    expect(leased).not.toBeNull();

    const row = db
      .query<
        { auction_score: number | null },
        [string]
      >(`SELECT auction_score FROM task_leases WHERE task_id = ? LIMIT 1`)
      .get(task_id);

    expect(row).not.toBeNull();
    expect(row!.auction_score).toBe(90);
  });

  test("preference_window_ms: 0 disables preferred hold and allows immediate FCFS", async () => {
    const writer = makeWriter([
      { agent_name: "A", score: 90 },
      { agent_name: "B", score: 30 },
    ]);
    const { task_id } = writer.file(
      baseInput({
        eligibility: { preference_window_ms: 0 },
      }),
    );

    nowMs = 0;
    const leased = await writer.next({ agent_id: "B" });
    expect(leased).not.toBeNull();
    expect(leased!.task_id).toBe(task_id);
  });

  test("auctioned event is written at most once per task across repeated next calls", async () => {
    const writer = makeWriter([
      { agent_name: "A", score: 90 },
      { agent_name: "B", score: 30 },
    ]);
    const { task_id } = writer.file(baseInput());

    nowMs = 5_000;
    expect(await writer.next({ agent_id: "B" })).toBeNull();
    expect(await writer.next({ agent_id: "B" })).toBeNull();
    expect(await writer.next({ agent_id: "B" })).toBeNull();

    const rows = db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'auctioned'`)
      .get(task_id);
    expect(rows).not.toBeNull();
    expect(rows!.n).toBe(1);
  });

  test(
    "concurrent next() calls: exactly one lease is created",
    async () => {
      const dbPath = freshDbFile();
      const dbDir = dbPath.slice(0, dbPath.lastIndexOf("/"));
      const { task_id } = ((): { task_id: string } => {
        const setupDb = new Database(dbPath);
        const writer = new TaskWriter(setupDb, {
          now: (): number => 10_000,
          resolveAgent: (name): AgentDescriptor | undefined => agents.get(name),
          routeAgent: (): RouteAgentOutput => raceRouteAgentOutput(),
        });
        try {
          return writer.file(baseInput());
        } finally {
          setupDb.close();
        }
      })();

      const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
      const workerSource = `
import { Database } from "bun:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { applyRuntimePragmas } from ${JSON.stringify(PRAGMAS_URL)};
import { TaskWriter } from ${JSON.stringify(WRITER_URL)};

try {
  const { dbPath, agentId, barrier } = workerData;
  const state = new Int32Array(barrier);
  const db = new Database(dbPath);
  // Every real production connection (daemon start, CLI init, MCP runtime) calls this
  // right after opening -- busy_timeout is a per-connection setting, so without it here
  // each worker's writer.next() would hit "database is locked" under real write
  // contention instead of retrying like production does.
  applyRuntimePragmas(db);
  const writer = new TaskWriter(db, {
    now: () => 10_000,
    resolveAgent: (name) => new Map([
      ["A", { name: "A", tags: ["core"], tier: "standard", cost_cents_per_run: 25 }],
      ["B", { name: "B", tags: ["core"], tier: "standard", cost_cents_per_run: 25 }],
    ]).get(name),
    routeAgent: () => ({
      detail: "rank",
      candidates: {
        task_type: "implement_substantial",
        window: { from: null, to: "" },
        candidates: [
          {
            agent_name: "A",
            samples: 1,
            successes: 1,
            failures: 0,
            neutral: 0,
            success_rate: 1,
            avg_rounds: null,
            avg_latency_ms: null,
            cost_per_success_usd: null,
            avg_reviewer_findings: null,
            avg_trust_score: null,
            score: 90,
            last_outcome_at: "",
          },
          {
            agent_name: "B",
            samples: 1,
            successes: 1,
            failures: 0,
            neutral: 0,
            success_rate: 1,
            avg_rounds: null,
            avg_latency_ms: null,
            cost_per_success_usd: null,
            avg_reviewer_findings: null,
            avg_trust_score: null,
            score: 30,
            last_outcome_at: "",
          },
        ],
      },
    }),
  });

  // Real cross-thread barrier instead of a wall-clock guess: each worker opens its own
  // SQLite connection, signals readiness, then blocks in Atomics.wait() until the parent
  // releases all ${String(RACE_CONCURRENCY)} contenders at once.
  const readyAt = Date.now();
  Atomics.add(state, 0, 1);
  Atomics.notify(state, 0);
  while (Atomics.load(state, 1) === 0) {
    Atomics.wait(state, 1, 0);
  }

  const callStartAt = Date.now();
  const result = await writer.next({ agent_id: agentId });
  db.close();
  parentPort.postMessage({ result, readyAt, callStartAt });
} catch (err) {
  parentPort.postMessage({
    error: err instanceof Error ? err.stack ?? err.message : String(err),
  });
}
`;

      type WorkerOutcome = { result: unknown; readyAt: number; callStartAt: number };
      type WorkerMessage = WorkerOutcome | { error: string };

      const workerStates: { worker: NodeWorker; exited: boolean }[] = [];
      const attempts = Array.from({ length: RACE_CONCURRENCY }, (_, i) => {
        const worker = new NodeWorker(workerSource, {
          eval: true,
          workerData: {
            dbPath,
            agentId: i % 2 === 0 ? "A" : "B",
            barrier,
          },
        });
        const workerState = { worker, exited: false };
        workerStates.push(workerState);
        const attempt = new Promise<WorkerOutcome>((resolve, reject) => {
          let received: WorkerMessage | null = null;
          worker.once("message", (message: WorkerMessage): void => {
            received = message;
          });
          worker.once("error", (err: Error): void => {
            reject(err);
          });
          worker.once("exit", (code: number): void => {
            workerState.exited = true;
            if (code !== 0) {
              reject(new Error(`worker exited ${String(code)}`));
              return;
            }
            if (received === null) {
              reject(new Error("worker exited without a result"));
              return;
            }
            if ("error" in received) {
              reject(new Error(received.error));
              return;
            }
            resolve(received);
          });
        });
        // The barrier readiness check can fail before the test reaches result collection.
        // Convert every worker attempt into a never-rejecting settled result immediately so
        // late worker exits remain owned by this test instead of surfacing between files.
        return attempt
          .then((value): PromiseSettledResult<WorkerOutcome> => ({ status: "fulfilled", value }))
          .catch(
            (reason: unknown): PromiseSettledResult<WorkerOutcome> => ({
              status: "rejected",
              reason,
            }),
          );
      });

      const __testStart = Date.now();
      try {
        const barrierState = new Int32Array(barrier);
        const readyDeadline = Date.now() + RACE_BARRIER_READY_TIMEOUT_MS;
        while (Atomics.load(barrierState, 0) < RACE_CONCURRENCY) {
          if (Date.now() >= readyDeadline) {
            throw new Error(
              `only ${String(Atomics.load(barrierState, 0))}/${String(RACE_CONCURRENCY)} workers reached the barrier within ${String(RACE_BARRIER_READY_TIMEOUT_MS)}ms`,
            );
          }
          Atomics.wait(barrierState, 0, Atomics.load(barrierState, 0), 10);
        }
        console.error(`[calibration] ready-wait took ${String(Date.now() - __testStart)}ms`);

        const releaseAt = Date.now();
        Atomics.store(barrierState, 1, 1);
        Atomics.notify(barrierState, 1, RACE_CONCURRENCY);

        const results = await Promise.all(attempts);
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        if (rejected.length > 0) {
          throw new Error(
            `${String(rejected.length)}/${String(RACE_CONCURRENCY)} workers failed: ${rejected.map((r) => String(r.reason)).join("; ")}`,
          );
        }
        const fulfilled = results
          .filter((r): r is PromiseFulfilledResult<WorkerOutcome> => r.status === "fulfilled")
          .map((r) => r.value);
        expect(fulfilled).toHaveLength(RACE_CONCURRENCY);

        // Self-audit: every worker must have signalled ready before the parent released,
        // and must not have started its next() call before that release. If the barrier
        // ever degenerates back into a staggered wall-clock guess, these fail loudly
        // instead of the test silently passing without real contention.
        for (const outcome of fulfilled) {
          expect(outcome.readyAt).toBeLessThanOrEqual(releaseAt);
          expect(outcome.callStartAt).toBeGreaterThanOrEqual(releaseAt);
        }
        const callStarts = fulfilled.map((o) => o.callStartAt);
        const spread = Math.max(...callStarts) - Math.min(...callStarts);
        expect(spread).toBeLessThan(RACE_BARRIER_SPREAD_THRESHOLD_MS);
        console.error(`[calibration] barrier spread ${String(spread)}ms`);

        const leaseResults = fulfilled.map((o) => o.result).filter((v) => v !== null);
        expect(leaseResults).toHaveLength(1);
        console.error(`[calibration] total test took ${String(Date.now() - __testStart)}ms`);

        const verificationDb = new Database(dbPath);
        const openLeases = verificationDb
          .query<
            { n: number },
            [string]
          >(`SELECT COUNT(*) AS n FROM task_leases WHERE task_id = ? AND released_at IS NULL`)
          .get(task_id);
        verificationDb.close();
        expect(openLeases!.n).toBe(1);
      } finally {
        await Promise.allSettled(
          workerStates
            .filter((workerState) => !workerState.exited)
            .map((workerState) => workerState.worker.terminate()),
        );
        rmSync(dbPath, { force: true });
        rmSync(dbDir, { recursive: true, force: true });
      }
    },
    RACE_TEST_TIMEOUT_MS,
  );
});

describe("pickPreferred", () => {
  test("uses latency as a tiebreak before name", () => {
    const out = pickPreferred(
      [
        { agent_name: "zulu-slow", score: 10, avg_latency_ms: 5000 },
        { agent_name: "aardvark-fast", score: 10, avg_latency_ms: 1000 },
      ],
      [
        { name: "zulu-slow", tags: ["core"], tier: "standard", cost_cents_per_run: 25 },
        { name: "aardvark-fast", tags: ["core"], tier: "standard", cost_cents_per_run: 25 },
      ],
    );

    expect(out).toEqual({ agent_id: "aardvark-fast", score: 10 });
  });
});

describe("pickPreferred public export", () => {
  test("selects the highest-scored eligible agent from the package root", () => {
    const out = exportedPickPreferred(
      [
        { agent_name: "a", score: 0.9 },
        { agent_name: "b", score: 0.4 },
      ],
      [
        { name: "a", tags: ["core"], tier: "standard", cost_cents_per_run: 25 },
        { name: "b", tags: ["core"], tier: "standard", cost_cents_per_run: 25 },
      ],
    );

    expect(out).toEqual({ agent_id: "a", score: 0.9 });
  });
});
