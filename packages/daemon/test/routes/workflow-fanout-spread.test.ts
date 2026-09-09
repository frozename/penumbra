import {
  buildServices,
  loadSqliteVec,
  migrate,
  type Services,
  type Watchdog,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { registerWorkerForTest } from "@penumbra/daemon/test-utils";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { chainsStartRoute } from "@src/routes/chains.js";
import { createDaemonFetchHandler } from "@src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

const SHARED_TOKEN = "shared-sec";
const WORKFLOW_RUN_ID = "wfrun-spread-e2e";

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/workflow-fanout-spread-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-26T00:00:00Z"),
    uuid: () => `wf-${String(++n)}`,
    agentRegistry: ["codex"],
    worktreeRootDir: "/private/tmp/penumbra-test-worktrees",
  });
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

function makeFetcher(handler: (req: Request) => Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(input as string, init))) as typeof fetch;
}

test("a route-issued workflow fan-out populates workflow_run_id and the claim-spread cap engages", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  const tokens = new Map<string, string>();
  for (const worker_id of ["W-A", "W-B", "W-C"]) {
    const { worker_token } = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: SHARED_TOKEN,
      worker_id,
      fetcher: makeFetcher(fetchHandler),
    });
    tokens.set(worker_id, worker_token);
  }

  const handoffIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const res = await chainsStartRoute(
      new Request("http://x/chains/start", {
        method: "POST",
        body: JSON.stringify({
          initial_agent: "codex",
          message: `fan-out sibling ${String(i)}`,
          project_id: "penumbra",
          dispatch_kind: "workflow",
          workflow_run_id: WORKFLOW_RUN_ID,
        }),
      }),
      services,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { handoff_id?: string };
    expect(typeof body.handoff_id).toBe("string");
    handoffIds.push(body.handoff_id ?? "");
  }

  const linked = services.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM handoffs
        WHERE dispatch_kind='workflow' AND workflow_run_id=?`,
    )
    .get(WORKFLOW_RUN_ID);
  expect(linked?.n).toBe(4);

  const claim = (handoff_id: string, worker_id: string): Promise<Response> =>
    fetchHandler(
      new Request(`http://x/handoffs/${handoff_id}/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.get(worker_id) ?? ""}` },
        body: JSON.stringify({ worker_id }),
      }),
    );

  // max_per_worker = ceil(4 siblings / 3 active workers) + 1 = 3
  for (const handoff_id of handoffIds.slice(0, 3)) {
    expect((await claim(handoff_id, "W-A")).status).toBe(200);
  }

  const capped = await claim(handoffIds[3] ?? "", "W-A");
  expect(capped.status).toBe(409);
  const cappedBody = (await capped.json()) as {
    error: { code: string };
    max_per_worker?: number;
    sibling_count?: number;
    active_worker_count?: number;
  };
  expect(cappedBody.error.code).toBe("claim_spread_cap");
  expect(cappedBody.sibling_count).toBe(4);
  expect(cappedBody.active_worker_count).toBe(3);
  expect(cappedBody.max_per_worker).toBe(3);

  expect((await claim(handoffIds[3] ?? "", "W-B")).status).toBe(200);

  const counts = services.db
    .query<{ worker_id: string; n: number }, [string]>(
      `SELECT worker_id, COUNT(*) AS n
         FROM handoffs
        WHERE workflow_run_id=? AND status='dispatched'
        GROUP BY worker_id
        ORDER BY worker_id`,
    )
    .all(WORKFLOW_RUN_ID);
  expect(counts).toEqual([
    { worker_id: "W-A", n: 3 },
    { worker_id: "W-B", n: 1 },
  ]);
});
