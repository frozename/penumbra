import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { registerWorkerForTest } from "@penumbra/daemon/test-utils";
import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

import { createDaemonFetchHandler } from "@src/serve.js";
import { createProviderCapacityReoffer } from "@src/services/provider-capacity-reoffer.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

const SHARED_TOKEN = "shared-sec";

type HandoffSseEvent = { handoff_id: string; status?: string };
type ClaimResponse = { status: string };
type ErrorResponse = {
  error: { code: string };
  provider: string;
  max_in_flight: number;
  in_flight_count: number;
};

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/handoffs-provider-reoffer-test",
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
  opts: { to?: string; tsOffsetMs?: number } = {},
): void {
  const ts = new Date(
    Date.parse("2026-05-21T10:00:00.000Z") + (opts.tsOffsetMs ?? 0),
  ).toISOString();
  services.handoffWriter.createApproved({
    handoff_id,
    ts,
    project_id: null,
    conversation_id: `conv-${handoff_id}`,
    from: "planner",
    to: opts.to ?? "claude-a",
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
    dispatch_kind: null,
    workflow_run_id: null,
  });
}

async function readSseEvents(
  stream: ReadableStream<Uint8Array>,
  n: number,
  timeoutMs = 1000,
): Promise<HandoffSseEvent[]> {
  const reader = stream.getReader();
  const events: HandoffSseEvent[] = [];
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (events.length < n && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((resolve) => {
        setTimeout(
          () => {
            resolve({ value: undefined, done: true });
          },
          Math.max(1, deadline - Date.now()),
        );
      }),
    ]);
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) events.push(JSON.parse(dataLine.slice(6)) as HandoffSseEvent);
    }
  }
  reader.releaseLock();
  return events;
}

function requireBody(res: Response): ReadableStream<Uint8Array> {
  if (!res.body) throw new Error("SSE response missing body");
  return res.body;
}

async function registerWorkers(fetchHandler: (req: Request) => Promise<Response>): Promise<{
  tokenA: string;
  tokenB: string;
}> {
  const a = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "W-A",
    fetcher: makeFetcher(fetchHandler),
  });
  const b = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "W-B",
    fetcher: makeFetcher(fetchHandler),
  });
  return { tokenA: a.worker_token, tokenB: b.worker_token };
}

async function claim(
  fetchHandler: (req: Request) => Promise<Response>,
  handoffId: string,
  workerId: string,
  token: string,
): Promise<Response> {
  return await fetchHandler(
    new Request(`http://x/handoffs/${handoffId}/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ worker_id: workerId }),
    }),
  );
}

async function complete(
  fetchHandler: (req: Request) => Promise<Response>,
  handoffId: string,
  token: string,
): Promise<Response> {
  return await fetchHandler(
    new Request(`http://x/handoffs/${handoffId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    }),
  );
}

function setup(): { services: Services; fetchHandler: (req: Request) => Promise<Response> } {
  const services = tempServices();
  configureProviderCap(services, 1);
  const log = { info: mock(), warn: mock(), debug: mock(), error: mock() };
  services.log = log as unknown as Services["log"];
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  seedApprovedHandoff(services, "provider-running", { to: "claude-a" });
  seedApprovedHandoff(services, "provider-next", { to: "claude-b", tsOffsetMs: 1 });
  return { services, fetchHandler };
}

test("a 429-refused claim is re-offered over GET /handoffs/events when the provider's in-flight dispatch completes, and the re-claim succeeds", async () => {
  const { services, fetchHandler } = setup();
  const reoffer = createProviderCapacityReoffer({ services });
  reoffer.start();
  const { tokenA, tokenB } = await registerWorkers(fetchHandler);

  const runningClaim = await claim(fetchHandler, "provider-running", "W-A", tokenA);
  expect(runningClaim.status).toBe(200);
  expect(((await runningClaim.json()) as ClaimResponse).status).toBe("dispatched");
  const refused = await claim(fetchHandler, "provider-next", "W-B", tokenB);
  expect(refused.status).toBe(429);
  expect((await refused.json()) as ErrorResponse).toMatchObject({
    error: { code: "provider_concurrency_cap" },
    provider: "anthropic",
    max_in_flight: 1,
    in_flight_count: 1,
  });
  expect(services.log.info).toHaveBeenCalledWith(
    expect.objectContaining({
      handoff_id: "provider-next",
      worker_id: "W-B",
      provider: "anthropic",
      max_in_flight: 1,
      in_flight_count: 1,
      path: "precheck",
    }),
    "claim refused: provider in-flight cap",
  );
  expect(countEvents(services, "provider-next", "claim.provider_cap_refused")).toBe(1);

  const sse = await fetchHandler(
    new Request("http://x/handoffs/events", {
      headers: { authorization: `Bearer ${SHARED_TOKEN}` },
    }),
  );
  expect(sse.status).toBe(200);
  expect(sse.headers.get("content-type")).toContain("text/event-stream");
  const done = await complete(fetchHandler, "provider-running", tokenA);
  expect(done.status).toBe(200);

  const events = await readSseEvents(requireBody(sse), 1);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ handoff_id: "provider-next", status: "approved" });
  expect(services.log.info).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "anthropic",
      cause: "left_dispatched",
      freed_by: "provider-running",
      to_status: "completed",
      max_in_flight: 1,
      in_flight_count: 0,
      free: 1,
      waiting: 1,
      reoffered: ["provider-next"],
    }),
    "provider capacity re-offer",
  );
  expect(countEvents(services, "provider-next", "claim.reoffer")).toBe(1);

  const reclaimed = await claim(fetchHandler, "provider-next", "W-B", tokenB);
  expect(reclaimed.status).toBe(200);
  expect(services.handoffReader.get("provider-next")).toMatchObject({
    status: "dispatched",
    worker_id: "W-B",
  });
  expect(eventKinds(services, "provider-next")).toEqual([
    "claim.provider_cap_refused",
    "claim.reoffer",
    "claim",
  ]);
  reoffer.stop();
  await requireBody(sse).cancel();
});

test("sweep() re-offers a still-waiting refused row when the transition signal was missed", async () => {
  const { services, fetchHandler } = setup();
  const { tokenA, tokenB } = await registerWorkers(fetchHandler);
  expect((await claim(fetchHandler, "provider-running", "W-A", tokenA)).status).toBe(200);
  expect((await claim(fetchHandler, "provider-next", "W-B", tokenB)).status).toBe(429);
  const missed = await fetchHandler(
    new Request("http://x/handoffs/events", {
      headers: { authorization: `Bearer ${SHARED_TOKEN}` },
    }),
  );

  expect((await complete(fetchHandler, "provider-running", tokenA)).status).toBe(200);
  expect(await readSseEvents(requireBody(missed), 1, 200)).toEqual([]);
  await requireBody(missed).cancel();

  const sse = await fetchHandler(
    new Request("http://x/handoffs/events", {
      headers: { authorization: `Bearer ${SHARED_TOKEN}` },
    }),
  );
  const reoffer = createProviderCapacityReoffer({ services });
  const summaries = reoffer.sweep();
  expect(summaries[0]).toMatchObject({
    provider: "anthropic",
    cause: "sweep",
    reoffered: ["provider-next"],
  });
  const events = await readSseEvents(requireBody(sse), 1);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ handoff_id: "provider-next", status: "approved" });
  expect((await claim(fetchHandler, "provider-next", "W-B", tokenB)).status).toBe(200);
  await requireBody(sse).cancel();
});

function countEvents(services: Services, handoffId: string, kind: string): number {
  return (
    services.db
      .query<
        { n: number },
        [string, string]
      >("SELECT COUNT(*) AS n FROM dispatch_events WHERE handoff_id=? AND kind=?")
      .get(handoffId, kind)?.n ?? 0
  );
}

function eventKinds(services: Services, handoffId: string): string[] {
  return services.db
    .query<{ kind: string }, [string]>(
      "SELECT kind FROM dispatch_events WHERE handoff_id=? ORDER BY ts, id",
    )
    .all(handoffId)
    .map((row) => row.kind);
}
