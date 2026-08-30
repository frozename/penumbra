import {
  buildServices,
  HandoffWriter,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { createDaemonFetchHandler } from "@src/serve.js";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { registerWorkerForTest } from "../../test-utils.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

const SHARED_TOKEN = "shared-sec";

type ErrorResponse = { error: { code: string } };
type ClaimResponse = { status: string };
type ProviderConcurrencyCapResponse = ErrorResponse & {
  provider: string;
  max_in_flight: number;
  in_flight_count: number;
};
type WorkerAuthz = Map<string, { isolation: "sticky" | "hard" | "shared"; project_id?: string }>;
type ClaimServices = Services & {
  workerAuthz?: WorkerAuthz;
};
type ClaimDispatchOptions = Parameters<HandoffWriter["claimDispatch"]>[2];

class RacingHandoffWriter extends HandoffWriter {
  private raced = false;

  constructor(
    db: Database,
    private readonly race: () => void,
  ) {
    super({ db });
  }

  override claimDispatch(
    handoff_id: string,
    worker_id: string,
    opts?: ClaimDispatchOptions,
  ): boolean {
    if (!this.raced) {
      this.raced = true;
      this.race();
    }
    return super.claimDispatch(handoff_id, worker_id, opts);
  }
}

async function readErrorCode(res: Response): Promise<string> {
  const body = (await res.json()) as ErrorResponse;
  return body.error.code;
}

function requireToken(tokens: Map<string, string>, workerId: string): string {
  const token = tokens.get(workerId);
  if (!token) throw new Error(`missing token for ${workerId}`);
  return token;
}

function expectRetryableClaimRefusalStatus(status: number): void {
  // A terminal 4xx makes the worker drop this fleet-wide refusal permanently instead of retrying.
  expect([408, 429]).toContain(status);
}

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/claim-dispatch-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-21T10:00:00Z"),
    uuid: (() => {
      let n = 0;
      return () => `e-${String(++n)}`;
    })(),
  });
}

function configureProviderCap(services: Services, max_in_flight: number): void {
  services.agentchatConfig = {
    agents: [
      {
        name: "claude-a",
        roles: [],
        adapter: "stdio-acp",
        pricing_mode: "subscription",
        subscription_provider: "anthropic",
      },
      {
        name: "claude-b",
        roles: [],
        adapter: "stdio-acp",
        pricing_mode: "subscription",
        subscription_provider: "anthropic",
      },
    ],
    default_roles: {},
    providers: [],
  };
  services.providerQuotas = [{ provider: "anthropic", max_in_flight }];
}

function makeFetcher(handler: (req: Request) => Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(input as string, init))) as typeof fetch;
}

function seedApprovedHandoff(
  services: Services,
  handoff_id: string,
  project_id: string | null = null,
  opts: {
    to?: string;
    dispatch_kind?: "workflow";
    workflow_run_id?: string;
    tsOffsetMs?: number;
  } = {},
): void {
  const ts = new Date(
    Date.parse("2026-05-21T10:00:00.000Z") + (opts.tsOffsetMs ?? 0),
  ).toISOString();
  services.handoffWriter.createApproved({
    handoff_id,
    ts,
    project_id,
    conversation_id: `conv-${handoff_id}`,
    from: "planner",
    to: opts.to ?? "worker",
    to_role: null,
    message: "go",
    triggered_by_event_id: null,
    resolved_by: "machine-test",
    resolved_at: "2026-05-21T10:00:00.000Z",
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
    dispatch_kind: opts.dispatch_kind ?? null,
    workflow_run_id: opts.workflow_run_id ?? null,
  });
}

test("/handoffs/:id/claim with shared bearer returns 403 worker_token_required", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  seedApprovedHandoff(services, "h-1");

  const res = await fetchHandler(
    new Request("http://x/handoffs/h-1/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${SHARED_TOKEN}` },
      body: JSON.stringify({ worker_id: "W-A" }),
    }),
  );
  expect(res.status).toBe(403);
  expect(await readErrorCode(res)).toBe("worker_token_required");

  const row = services.db
    .query<
      { status: string; worker_id: string | null },
      [string]
    >("SELECT status, worker_id FROM handoffs WHERE handoff_id = ?")
    .get("h-1");
  expect(row?.status).toBe("approved");
  expect(row?.worker_id).toBeNull();
});

test("/handoffs/:id/claim with worker token + mismatched body returns 403 worker_id_mismatch", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  seedApprovedHandoff(services, "h-2");

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "W-A",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request("http://x/handoffs/h-2/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "W-B" }),
    }),
  );
  expect(res.status).toBe(403);
  expect(await readErrorCode(res)).toBe("worker_id_mismatch");

  const row = services.db
    .query<{ status: string }, [string]>("SELECT status FROM handoffs WHERE handoff_id = ?")
    .get("h-2");
  expect(row?.status).toBe("approved");
});

test("/handoffs/:id/claim with worker token + matching body claims successfully", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  seedApprovedHandoff(services, "h-3");

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "W-A",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request("http://x/handoffs/h-3/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "W-A" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as ClaimResponse;
  expect(body.status).toBe("dispatched");

  const row = services.db
    .query<
      { status: string; worker_id: string | null },
      [string]
    >("SELECT status, worker_id FROM handoffs WHERE handoff_id = ?")
    .get("h-3");
  expect(row?.status).toBe("dispatched");
  expect(row?.worker_id).toBe("W-A");
});

test("Claim collision: W-A claims; W-B token + W-B body cannot steal", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  seedApprovedHandoff(services, "h-4");

  const { worker_token: tokenA } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "W-A",
    fetcher: makeFetcher(fetchHandler),
  });
  const { worker_token: tokenB } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "W-B",
    fetcher: makeFetcher(fetchHandler),
  });

  const resA = await fetchHandler(
    new Request("http://x/handoffs/h-4/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ worker_id: "W-A" }),
    }),
  );
  expect(resA.status).toBe(200);

  const resB = await fetchHandler(
    new Request("http://x/handoffs/h-4/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ worker_id: "W-B" }),
    }),
  );
  expect(resB.status).toBe(409);

  const row = services.db
    .query<
      { worker_id: string | null },
      [string]
    >("SELECT worker_id FROM handoffs WHERE handoff_id = ?")
    .get("h-4");
  expect(row?.worker_id).toBe("W-A");
});

test("workflow fan-out sibling claims are spread across active workers without exceeding the per-worker cap", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  const workerIds = ["W-A", "W-B", "W-C"];
  const tokens = new Map<string, string>();
  for (const worker_id of workerIds) {
    const { worker_token } = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: SHARED_TOKEN,
      worker_id,
      fetcher: makeFetcher(fetchHandler),
    });
    tokens.set(worker_id, worker_token);
  }

  for (let i = 0; i < 10; i++) {
    seedApprovedHandoff(services, `fanout-${String(i)}`, null, {
      dispatch_kind: "workflow",
      workflow_run_id: "workflow-spread-1",
      tsOffsetMs: i,
    });
  }

  for (let i = 0; i < 5; i++) {
    const res = await fetchHandler(
      new Request(`http://x/handoffs/fanout-${String(i)}/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${requireToken(tokens, "W-A")}` },
        body: JSON.stringify({ worker_id: "W-A" }),
      }),
    );
    expect(res.status).toBe(200);
  }

  const overCap = await fetchHandler(
    new Request("http://x/handoffs/fanout-5/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${requireToken(tokens, "W-A")}` },
      body: JSON.stringify({ worker_id: "W-A" }),
    }),
  );
  expect(overCap.status).toBe(409);
  expect(await readErrorCode(overCap)).toBe("claim_spread_cap");

  const spreadClaim = await fetchHandler(
    new Request("http://x/handoffs/fanout-5/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${requireToken(tokens, "W-B")}` },
      body: JSON.stringify({ worker_id: "W-B" }),
    }),
  );
  expect(spreadClaim.status).toBe(200);

  const counts = services.db
    .query<{ worker_id: string; n: number }, []>(
      `SELECT worker_id, COUNT(*) AS n
         FROM handoffs
        WHERE workflow_run_id = 'workflow-spread-1'
          AND status = 'dispatched'
        GROUP BY worker_id
        ORDER BY worker_id`,
    )
    .all();
  expect(counts).toEqual([
    { worker_id: "W-A", n: 5 },
    { worker_id: "W-B", n: 1 },
  ]);
});

test("/handoffs/:id/claim returns retryable typed response when provider in-flight cap is reached", async () => {
  const services = tempServices();
  configureProviderCap(services, 1);
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  seedApprovedHandoff(services, "provider-running", null, { to: "claude-a" });
  seedApprovedHandoff(services, "provider-next", null, { to: "claude-b" });

  const { worker_token: tokenA } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "W-A",
    fetcher: makeFetcher(fetchHandler),
  });
  const { worker_token: tokenB } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "W-B",
    fetcher: makeFetcher(fetchHandler),
  });

  const first = await fetchHandler(
    new Request("http://x/handoffs/provider-running/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ worker_id: "W-A" }),
    }),
  );
  expect(first.status).toBe(200);

  const capped = await fetchHandler(
    new Request("http://x/handoffs/provider-next/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ worker_id: "W-B" }),
    }),
  );

  expectRetryableClaimRefusalStatus(capped.status);
  const body = (await capped.json()) as ProviderConcurrencyCapResponse;
  expect(body.error.code).toBe("provider_concurrency_cap");
  expect(body.provider).toBe("anthropic");
  expect(body.max_in_flight).toBe(1);
  expect(body.in_flight_count).toBe(1);

  const row = services.db
    .query<
      { status: string; worker_id: string | null },
      [string]
    >("SELECT status, worker_id FROM handoffs WHERE handoff_id = ?")
    .get("provider-next");
  expect(row).toEqual({ status: "approved", worker_id: null });
});

test("/handoffs/:id/claim returns retryable provider cap response when CAS loses to provider cap race", async () => {
  const services = tempServices();
  configureProviderCap(services, 1);
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  seedApprovedHandoff(services, "provider-running-race", null, { to: "claude-a" });
  seedApprovedHandoff(services, "provider-race-next", null, { to: "claude-b" });
  services.handoffWriter = new RacingHandoffWriter(services.db, () => {
    services.db.run(
      `UPDATE handoffs SET status='dispatched', worker_id='W-A' WHERE handoff_id='provider-running-race'`,
    );
  });

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "W-B",
    fetcher: makeFetcher(fetchHandler),
  });

  const raced = await fetchHandler(
    new Request("http://x/handoffs/provider-race-next/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "W-B" }),
    }),
  );

  expectRetryableClaimRefusalStatus(raced.status);
  const body = (await raced.json()) as ProviderConcurrencyCapResponse;
  expect(body.error.code).toBe("provider_concurrency_cap");
  expect(body.provider).toBe("anthropic");
  expect(body.max_in_flight).toBe(1);
  expect(body.in_flight_count).toBe(1);

  const row = services.db
    .query<
      { status: string; worker_id: string | null },
      [string]
    >("SELECT status, worker_id FROM handoffs WHERE handoff_id = ?")
    .get("provider-race-next");
  expect(row).toEqual({ status: "approved", worker_id: null });
});

test("/handoffs/:id/claim returns generic terminal conflict when CAS loses because row is already claimed", async () => {
  const services = tempServices();
  configureProviderCap(services, 1);
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  seedApprovedHandoff(services, "provider-row-claimed-race", null, { to: "claude-b" });
  services.handoffWriter = new RacingHandoffWriter(services.db, () => {
    services.db.run(
      `UPDATE handoffs SET status='dispatched', worker_id='W-A' WHERE handoff_id='provider-row-claimed-race'`,
    );
  });

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "W-B",
    fetcher: makeFetcher(fetchHandler),
  });

  const raced = await fetchHandler(
    new Request("http://x/handoffs/provider-row-claimed-race/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "W-B" }),
    }),
  );

  expect(raced.status).toBe(409);
  const body = (await raced.json()) as ErrorResponse & { current_status: string | null };
  expect(body.error.code).toBe("conflict");
  expect(body.current_status).toBe("dispatched");
});

test("/handoffs/:id/claim uses provider-wide max_in_flight regardless of quota row order", async () => {
  const services = tempServices();
  services.agentchatConfig = {
    agents: [
      {
        name: "google-a",
        roles: [],
        adapter: "stdio-acp",
        pricing_mode: "subscription",
        subscription_provider: "google",
        subscription_model: "gemini-x",
      },
      {
        name: "google-b",
        roles: [],
        adapter: "stdio-acp",
        pricing_mode: "subscription",
        subscription_provider: "google",
        subscription_model: "gemini-y",
      },
    ],
    default_roles: {},
    providers: [],
  };
  services.providerQuotas = [
    { provider: "google", model: "gemini-x", max_in_flight: 1 },
    { provider: "google", max_in_flight: 2 },
  ];
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  seedApprovedHandoff(services, "provider-order-running", null, { to: "google-a" });
  seedApprovedHandoff(services, "provider-order-next", null, { to: "google-b" });

  const { worker_token: tokenA } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "W-A",
    fetcher: makeFetcher(fetchHandler),
  });
  const { worker_token: tokenB } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "W-B",
    fetcher: makeFetcher(fetchHandler),
  });

  const first = await fetchHandler(
    new Request("http://x/handoffs/provider-order-running/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ worker_id: "W-A" }),
    }),
  );
  expect(first.status).toBe(200);

  const second = await fetchHandler(
    new Request("http://x/handoffs/provider-order-next/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ worker_id: "W-B" }),
    }),
  );

  expect(second.status).toBe(200);
  const count = services.db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n
         FROM handoffs
        WHERE status='dispatched'
          AND to_agent IN ('google-a', 'google-b')`,
    )
    .get();
  expect(count?.n).toBe(2);
});

test("workflow sibling spreading does not block a warm-pool home worker", async () => {
  const services = tempServices();
  services.agentchatConfig = {
    agents: [{ name: "warm-agent", roles: [], options: { warm_pool: true } }],
  };
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  (services as ClaimServices).workerAuthz = new Map([
    ["W-HOME", { project_id: "project-a", isolation: "sticky" }],
    ["W-OTHER", { project_id: "project-b", isolation: "sticky" }],
    ["W-THIRD", { project_id: "project-c", isolation: "sticky" }],
  ]);

  const tokens = new Map<string, string>();
  for (const worker_id of ["W-HOME", "W-OTHER", "W-THIRD"]) {
    const { worker_token } = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: SHARED_TOKEN,
      worker_id,
      fetcher: makeFetcher(fetchHandler),
    });
    tokens.set(worker_id, worker_token);
  }

  for (let i = 0; i < 8; i++) {
    seedApprovedHandoff(services, `warm-${String(i)}`, "project-a", {
      to: "warm-agent",
      dispatch_kind: "workflow",
      workflow_run_id: "workflow-warm-1",
      tsOffsetMs: i,
    });
  }

  for (let i = 0; i < 5; i++) {
    const res = await fetchHandler(
      new Request(`http://x/handoffs/warm-${String(i)}/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${requireToken(tokens, "W-HOME")}` },
        body: JSON.stringify({ worker_id: "W-HOME" }),
      }),
    );
    expect(res.status).toBe(200);
  }

  const count = services.db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n
         FROM handoffs
        WHERE workflow_run_id = 'workflow-warm-1'
          AND status = 'dispatched'
          AND worker_id = 'W-HOME'`,
    )
    .get();
  expect(count?.n).toBe(5);
});

test("/handoffs/:id/claim without Authorization returns 401", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  seedApprovedHandoff(services, "h-5");

  const res = await fetchHandler(
    new Request("http://x/handoffs/h-5/claim", {
      method: "POST",
      body: JSON.stringify({ worker_id: "W-A" }),
    }),
  );
  expect(res.status).toBe(401);
  expect(await readErrorCode(res)).toBe("unauthorized");
});

test("/handoffs/:id/claim hard-isolated worker cannot claim foreign project handoff", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  seedApprovedHandoff(services, "h-6", "project-b");

  const workerId = "worker-extras-hard-projA";
  (services as ClaimServices).workerAuthz = new Map([
    [workerId, { project_id: "project-a", isolation: "hard" }],
  ]);

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: workerId,
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request("http://x/handoffs/h-6/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: workerId }),
    }),
  );

  expect(res.status).toBe(403);
  expect(await readErrorCode(res)).toBe("project_mismatch");

  const row = services.db
    .query<
      { status: string; worker_id: string | null },
      [string]
    >("SELECT status, worker_id FROM handoffs WHERE handoff_id = ?")
    .get("h-6");
  expect(row?.status).toBe("approved");
  expect(row?.worker_id).toBeNull();
});
