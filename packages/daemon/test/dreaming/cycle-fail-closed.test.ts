import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { DreamConfig } from "@src/dreaming/config.js";
import {
  type DreamCycleDeps,
  type ProjectRegistryEntry,
  runDreamCycle,
} from "@src/dreaming/cycle.js";
import { dreamingHealthRoute } from "@src/routes/dreaming.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // Optional Homebrew SQLite is unavailable in some CI images.
}

type RewriterCandidates = NonNullable<DreamCycleDeps["rewriterCandidates"]>;

interface DreamCycleRow {
  outcome: string;
  bail_reason: string | null;
  ended_at: number | null;
  phases_run: string;
}

interface HealthBody {
  current_running_cycle: unknown;
  cycles_crashed_24h: number;
  query_rewrite_failed_24h: number;
  subsystem_health: null | {
    seat: string | null;
    consecutive_failures: number;
    last_failure_reason: string | null;
  };
}

const PROJECT_ID = "proj-rewriter-fail-closed";
const MEMORY_TITLE = "TypeScript strict null checks in async systems";

function makeServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/dreaming-fail-closed-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date(),
    uuid: (() => {
      let n = 0;
      return (): string => `evt-${String(++n)}`;
    })(),
  });
}

function cycleConfig(): DreamConfig {
  return {
    enabled: true,
    cronMinutes: 30,
    perCycleUsd: 1.0,
    dailyUsd: 100.0,
    curatorEnabled: false,
    pressureGuardEnabled: true,
    perCycleEmbeddingUsd: 0.1,
    perCycleResearchUsd: 0.25,
    linkAutoThreshold: 0.75,
    p1BatchSize: 10,
    t2PromotionMinEvents: 5,
    contentQualityThreshold: 0.7,
    reembedBatchSize: 100,
    eventTriggerEnabled: false,
    idleMinutes: 15,
    triggerCooldownMinutes: 5,
    briefRefreshHours: 24,
    pc1BatchSize: 10,
    pc2MinClusterSize: 3,
    pc2ClusterLinkThreshold: 0.85,
    pc2AutoThreshold: 0.97,
    rewriterEnabled: true,
    rewriterBaseUrl: "http://127.0.0.1:7944",
    rewriterModel: "rewriter-a",
    rewriterTimeoutMs: 5000,
    rewriterCacheTtlMs: 30 * 24 * 60 * 60 * 1000,
    rewriterConcurrency: 4,
    skipPhases: new Set(),
  };
}

function seedMemory(services: Services): void {
  const now = new Date().toISOString();
  services.db
    .prepare(
      `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at, project_id)
       VALUES(?, 'test-user', 'knowledge', ?, ?, ?, 'body', ?, ?, ?)`,
    )
    .run(crypto.randomUUID(), now, now, MEMORY_TITLE, now, now, PROJECT_ID);
}

function excludeProvider(services: Services, provider: string): void {
  const now = Date.now();
  services.db
    .prepare(
      `INSERT INTO routing_bias(bias_id, scope, value, mode, weight, reason, created_at, expires_at)
       VALUES(?, 'provider', ?, 'exclude', NULL, 'test', ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      provider,
      new Date(now).toISOString(),
      new Date(now + 86_400_000).toISOString(),
    );
}

const PROJECT: ProjectRegistryEntry = {
  project_id: PROJECT_ID,
  dreaming: { research_provider: "firecrawl" },
};

const projectRegistry: NonNullable<DreamCycleDeps["projectRegistry"]> = {
  get: (id) => (id === PROJECT_ID ? PROJECT : undefined),
  list: () => [PROJECT],
};

async function runWithRealInvoker(
  services: Services,
  rewriterCandidates: RewriterCandidates,
): Promise<string> {
  return await runDreamCycle(services.db, cycleConfig(), {
    projectRegistry,
    dispatchEventLog: services.dispatchEventLog,
    rewriterCandidates,
  });
}

function onlyCycle(services: Services): DreamCycleRow {
  const rows = services.db
    .query<DreamCycleRow, []>(`SELECT outcome, bail_reason, ended_at, phases_run FROM dream_cycles`)
    .all();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function rewriteFailureMeta(services: Services, cycleId: string): Record<string, unknown>[] {
  return services.dispatchEventLog
    .listByHandoff(cycleId)
    .filter((event) => event.kind === "dream_p4_query_rewrite_failed")
    .map((event) => JSON.parse(event.meta_json ?? "{}") as Record<string, unknown>);
}

function queuedResearchQueries(services: Services): string[] {
  return services.db
    .query<{ payload_json: string }, []>(
      `SELECT payload_json FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
    )
    .all()
    .map((row) => (JSON.parse(row.payload_json) as { query: string }).query);
}

async function healthBody(services: Services): Promise<HealthBody> {
  const response = dreamingHealthRoute(new Request("http://x/dreaming/health"), services);
  expect(response.status).toBe(200);
  return (await response.json()) as HealthBody;
}

describe("dream cycle rewriter fail-closed paths", () => {
  test("records a rewrite failure and finishes the cycle when every rewriter seat is bias-excluded", async () => {
    const services = makeServices();
    seedMemory(services);
    excludeProvider(services, "local");

    const cycleId = await runWithRealInvoker(services, [
      {
        name: "local-rewriter",
        baseUrl: "http://127.0.0.1:7944/v1",
        model: "rewriter-a",
        provider: "local",
        auth: { source: "none" },
      },
    ]);

    const cycle = onlyCycle(services);
    expect(cycle.outcome).toBe("completed");
    expect(JSON.parse(cycle.phases_run) as string[]).toEqual([
      "P0",
      "P1",
      "P2",
      "P3",
      "P4",
      "P5",
      "P6",
      "P7",
      "P8",
    ]);
    const failures = rewriteFailureMeta(services, cycleId);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      reason: "no_eligible_candidate",
      model: "rewriter-a",
      failure_message: expect.stringMatching(/after routing biases/) as unknown,
    });
    expect(queuedResearchQueries(services)).toEqual([MEMORY_TITLE]);

    const health = await healthBody(services);
    expect(health.current_running_cycle).toBeNull();
    expect(health.query_rewrite_failed_24h).toBe(1);
    expect(health.subsystem_health).toMatchObject({
      seat: "local-rewriter",
      consecutive_failures: 1,
      last_failure_reason: "no_eligible_candidate",
    });
  });

  test("records a rewrite failure when a rewriter seat's provider is outside the allowlist", async () => {
    const services = makeServices();
    seedMemory(services);

    const cycleId = await runWithRealInvoker(services, [
      {
        name: "claude-rewriter",
        baseUrl: "https://api.anthropic.com/v1",
        model: "claude-haiku",
        provider: "anthropic",
        auth: { source: "bearer", token: "test-token" },
      },
    ]);

    expect(onlyCycle(services).outcome).toBe("completed");
    const failures = rewriteFailureMeta(services, cycleId);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      reason: "no_eligible_candidate",
      model: "claude-haiku",
      failure_message: expect.stringMatching(/provider 'anthropic' is not allowed/) as unknown,
    });
    expect(queuedResearchQueries(services)).toEqual([MEMORY_TITLE]);
    expect((await healthBody(services)).subsystem_health).toMatchObject({
      seat: "claude-rewriter",
      last_failure_reason: "no_eligible_candidate",
    });
  });

  test("marks the cycle crashed when a phase throws, so health stops reporting it as running", async () => {
    const services = makeServices();
    const boom = new Error("project registry unavailable");

    let caught: unknown;
    try {
      await runDreamCycle(services.db, cycleConfig(), {
        projectRegistry: {
          get: () => undefined,
          list: () => {
            throw boom;
          },
        },
        dispatchEventLog: services.dispatchEventLog,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(boom);
    const cycle = onlyCycle(services);
    expect(cycle.outcome).toBe("crashed");
    expect(cycle.bail_reason).toBe("phase_error: project registry unavailable");
    expect(cycle.ended_at).not.toBeNull();
    const health = await healthBody(services);
    expect(health.current_running_cycle).toBeNull();
    expect(health.cycles_crashed_24h).toBe(1);
  });
});
