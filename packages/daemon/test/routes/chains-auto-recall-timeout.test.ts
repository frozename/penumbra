import {
  buildServices,
  loadSqliteVec,
  migrate,
  ProjectRegistry,
  type RecallRequest,
  type RecallResult,
  type Services,
  type Watchdog,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { chainsStartRoute } from "@src/routes/chains.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

const STABLE_TS = "2026-04-26T00:00:00Z";

const testWatchdog: Watchdog = {
  recordHeartbeat: () => undefined,
  hasActiveWorker: () => true,
  getStaleWorkers: () => [],
  getStaleHeartbeatAges: () => [],
  tick: () => Promise.resolve(),
};

function fakeRecallHit(id: string, title: string): RecallResult {
  return {
    id,
    tier: "t2",
    score: 1,
    fusedScore: 1,
    sources: ["t2"],
    title,
    body: "",
    project_id: null,
    source_session_ids: [],
    created_at: STABLE_TS,
    ts: STABLE_TS,
  };
}

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/chains-auto-recall-timeout-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date(STABLE_TS),
    uuid: (() => {
      let n = 0;
      return (): string => `id-${String(++n)}`;
    })(),
    projectRegistry: new ProjectRegistry(
      new Map([["penumbra", { project_id: "penumbra", root_path: "/tmp/penumbra" }]]),
    ),
  });
  services.watchdog = testWatchdog;
  return services;
}

function withAutoRecallEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previousAutoRecall = process.env.PENUMBRA_AUTO_RECALL_ENABLED;
  const previousProjectFlag = process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
  const previousPromptMatch = process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;
  process.env.PENUMBRA_AUTO_RECALL_ENABLED = "true";
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
  delete process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;

  return fn().finally(() => {
    if (previousAutoRecall === undefined) delete process.env.PENUMBRA_AUTO_RECALL_ENABLED;
    else process.env.PENUMBRA_AUTO_RECALL_ENABLED = previousAutoRecall;
    if (previousProjectFlag === undefined) {
      delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
    } else {
      process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = previousProjectFlag;
    }
    if (previousPromptMatch === undefined) {
      delete process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;
    } else {
      process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = previousPromptMatch;
    }
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("auto-recall deadline aborts the in-flight recall instead of abandoning it", async () => {
  const services = tempServices();
  let seenSignal: AbortSignal | undefined;
  let releaseRecall: (() => void) | undefined;

  try {
    await withAutoRecallEnv(async () => {
      services.recallReader.recall = (
        _req: RecallRequest,
        opts?: { signal?: AbortSignal },
      ): Promise<RecallResult[]> => {
        seenSignal = opts?.signal;
        return new Promise<RecallResult[]>((resolve) => {
          releaseRecall = (): void => {
            resolve([]);
          };
        });
      };

      const res = await chainsStartRoute(
        new Request("http://x/chains/start", {
          method: "POST",
          body: JSON.stringify({
            initial_agent: "planner",
            message: "boundary work",
            task_class: "BOUNDARY",
            project_id: "penumbra",
          }),
        }),
        services,
      );

      expect(res.status).toBe(200);
      expect(seenSignal).toBeDefined();
      expect(seenSignal?.aborted).toBe(true);
      releaseRecall?.();
    });
  } finally {
    releaseRecall?.();
    services.db.close();
  }
}, 10_000);

test("successful auto-recall clears the deadline timer without aborting the recall signal", async () => {
  const services = tempServices();
  let seenSignal: AbortSignal | undefined;

  try {
    await withAutoRecallEnv(async () => {
      services.recallReader.recall = (
        _req: RecallRequest,
        opts?: { signal?: AbortSignal },
      ): Promise<RecallResult[]> => {
        seenSignal = opts?.signal;
        return Promise.resolve([fakeRecallHit("m1", "memo1")]);
      };

      const res = await chainsStartRoute(
        new Request("http://x/chains/start", {
          method: "POST",
          body: JSON.stringify({
            initial_agent: "planner",
            message: "standard work",
            task_class: "STANDARD",
            project_id: "penumbra",
          }),
        }),
        services,
      );

      expect(res.status).toBe(200);
      expect(seenSignal).toBeDefined();
      expect(seenSignal?.aborted).toBe(false);
      await wait(1_650);
      expect(seenSignal?.aborted).toBe(false);
    });
  } finally {
    services.db.close();
  }
}, 10_000);
