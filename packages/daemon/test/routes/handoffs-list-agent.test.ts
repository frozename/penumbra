import {
  buildServices,
  loadSqliteVec,
  migrate,
  ProjectRegistry,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { registerWorkerForTest } from "@penumbra/daemon/test-utils";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { createDaemonFetchHandler } from "@src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

function buildClaimTestServices(): { services: Services; db: Database } {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/handoffs-claim-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-04-25T20:00:00Z"),
    uuid: (): string => `e-${String(++n)}`,
  });
  return { services, db };
}

type WorkerAuthzMap = Map<string, { project_id?: string; isolation: "hard" | "sticky" | "shared" }>;
function stubWorkerAuthz(
  services: Services,
  entries: [string, { project_id: string; isolation: "hard" | "sticky" | "shared" }][],
): void {
  (services as Services & { workerAuthz?: WorkerAuthzMap }).workerAuthz = new Map(entries);
}

function makeFetcher(handler: (req: Request) => Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req =
      typeof input === "string" || input instanceof URL
        ? new Request(input.toString(), init)
        : input;
    return handler(req);
  }) as typeof fetch;
}

interface PendingRowSeed {
  handoff_id: string;
  project_id: string;
  to_agent?: string;
}

function seedPendingRows(services: Services, rows: PendingRowSeed[]): void {
  for (const row of rows) {
    services.handoffWriter.create({
      handoff_id: row.handoff_id,
      ts: "2026-09-01T11:59:00.000Z",
      from: "claude",
      to: row.to_agent ?? "agent-b",
      to_role: null,
      message: `m-${row.handoff_id}`,
      conversation_id: `conv-${row.handoff_id}`,
      project_id: row.project_id,
      triggered_by_event_id: `e-${row.handoff_id}`,
    });
  }
}

interface CompletedRowSeed {
  handoff_id: string;
  project_id: string;
  to_agent: string;
  resolved_at: string;
}

function seedCompletedRows(db: Database, rows: CompletedRowSeed[]): void {
  for (const row of rows) {
    db.run(
      `INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, message, status, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?)`,
      [
        row.handoff_id,
        "2026-04-25T18:00:00.000Z",
        row.project_id,
        `conv-${row.handoff_id}`,
        "a",
        row.to_agent,
        `m-${row.handoff_id}`,
        row.resolved_at,
      ],
    );
  }
}

const SINCE_TS = "2026-04-25T19:00:00.000Z";
const SINCE_TS_ENCODED = "2026-04-25T19%3A00%3A00.000Z";

test("GET /handoffs?agent=<a> as a hard-isolated worker returns only its own project's rows", async () => {
  const { services } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });
  services.projectRegistry = new ProjectRegistry(
    new Map([
      ["proj-a", { project_id: "proj-a", root_path: "/tmp/proj-a" }],
      ["proj-b", { project_id: "proj-b", root_path: "/tmp/proj-b" }],
    ]),
  );
  stubWorkerAuthz(services, [["worker-hard-projA", { project_id: "proj-a", isolation: "hard" }]]);
  seedPendingRows(services, [
    { handoff_id: "h-a1", project_id: "proj-a", to_agent: "agent-b" },
    { handoff_id: "h-b1", project_id: "proj-b", to_agent: "agent-b" },
  ]);

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: TOKEN,
    worker_id: "worker-hard-projA",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request("http://x/handoffs?agent=agent-b", {
      headers: { authorization: `Bearer ${worker_token}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    handoffs: { handoff_id: string; project_id: string | null }[];
  };
  expect(body.handoffs).toHaveLength(1);
  expect(body.handoffs[0]!.project_id).toBe("proj-a");
});

test("GET /handoffs (no status) as a hard-isolated worker returns only its own project's rows", async () => {
  const { services } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });
  services.projectRegistry = new ProjectRegistry(
    new Map([
      ["proj-a", { project_id: "proj-a", root_path: "/tmp/proj-a" }],
      ["proj-b", { project_id: "proj-b", root_path: "/tmp/proj-b" }],
    ]),
  );
  stubWorkerAuthz(services, [["worker-hard-projA", { project_id: "proj-a", isolation: "hard" }]]);
  seedPendingRows(services, [
    { handoff_id: "h-a1", project_id: "proj-a" },
    { handoff_id: "h-b1", project_id: "proj-b" },
  ]);

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: TOKEN,
    worker_id: "worker-hard-projA",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request("http://x/handoffs", {
      headers: { authorization: `Bearer ${worker_token}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    handoffs: { handoff_id: string; project_id: string | null }[];
  };
  expect(body.handoffs).toHaveLength(1);
  expect(body.handoffs[0]!.project_id).toBe("proj-a");
});

test("GET /handoffs/pending as a hard-isolated worker returns only its own project's rows", async () => {
  const { services } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });
  services.projectRegistry = new ProjectRegistry(
    new Map([
      ["proj-a", { project_id: "proj-a", root_path: "/tmp/proj-a" }],
      ["proj-b", { project_id: "proj-b", root_path: "/tmp/proj-b" }],
    ]),
  );
  stubWorkerAuthz(services, [["worker-hard-projA", { project_id: "proj-a", isolation: "hard" }]]);
  seedPendingRows(services, [
    { handoff_id: "h-a1", project_id: "proj-a" },
    { handoff_id: "h-b1", project_id: "proj-b" },
  ]);

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: TOKEN,
    worker_id: "worker-hard-projA",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request("http://x/handoffs/pending", {
      headers: { authorization: `Bearer ${worker_token}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    handoffs: { handoff_id: string; project_id: string | null }[];
  };
  expect(body.handoffs).toHaveLength(1);
  expect(body.handoffs[0]!.project_id).toBe("proj-a");
});

test("GET /handoffs?status=completed&since=<ts> as a hard-isolated worker counts only its own project", async () => {
  const { services, db } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });
  services.projectRegistry = new ProjectRegistry(
    new Map([
      ["proj-a", { project_id: "proj-a", root_path: "/tmp/proj-a" }],
      ["proj-b", { project_id: "proj-b", root_path: "/tmp/proj-b" }],
    ]),
  );
  stubWorkerAuthz(services, [["worker-hard-projA", { project_id: "proj-a", isolation: "hard" }]]);
  seedCompletedRows(db, [
    {
      handoff_id: "c-a1",
      project_id: "proj-a",
      to_agent: "agent-b",
      resolved_at: "2026-04-25T19:30:00.000Z",
    },
    {
      handoff_id: "c-b1",
      project_id: "proj-b",
      to_agent: "agent-b",
      resolved_at: "2026-04-25T19:30:00.000Z",
    },
  ]);

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: TOKEN,
    worker_id: "worker-hard-projA",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request(`http://x/handoffs?status=completed&since=${SINCE_TS_ENCODED}`, {
      headers: { authorization: `Bearer ${worker_token}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { done: number };
  expect(body.done).toBe(1);
});

test("GET /handoffs?status=completed&since=<ts>&agent=<a> counts only that agent's rows", async () => {
  const { services, db } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });
  services.projectRegistry = new ProjectRegistry(
    new Map([
      ["proj-a", { project_id: "proj-a", root_path: "/tmp/proj-a" }],
      ["proj-b", { project_id: "proj-b", root_path: "/tmp/proj-b" }],
    ]),
  );
  stubWorkerAuthz(services, [["worker-hard-projA", { project_id: "proj-a", isolation: "hard" }]]);
  seedCompletedRows(db, [
    {
      handoff_id: "c-a1",
      project_id: "proj-a",
      to_agent: "agent-a",
      resolved_at: "2026-04-25T19:30:00.000Z",
    },
    {
      handoff_id: "c-a2",
      project_id: "proj-a",
      to_agent: "agent-b",
      resolved_at: "2026-04-25T19:30:00.000Z",
    },
    {
      handoff_id: "c-b1",
      project_id: "proj-b",
      to_agent: "agent-a",
      resolved_at: "2026-04-25T19:30:00.000Z",
    },
  ]);

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: TOKEN,
    worker_id: "worker-hard-projA",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request(`http://x/handoffs?status=completed&since=${SINCE_TS_ENCODED}&agent=agent-a`, {
      headers: { authorization: `Bearer ${worker_token}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { done: number };
  expect(body.done).toBe(1);
});

test("GET /handoffs as a SHARED-BEARER principal still returns rows from every project", async () => {
  const { services } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });
  services.projectRegistry = new ProjectRegistry(
    new Map([
      ["proj-a", { project_id: "proj-a", root_path: "/tmp/proj-a" }],
      ["proj-b", { project_id: "proj-b", root_path: "/tmp/proj-b" }],
    ]),
  );
  seedPendingRows(services, [
    { handoff_id: "h-a1", project_id: "proj-a" },
    { handoff_id: "h-b1", project_id: "proj-b" },
  ]);

  const res = await fetchHandler(
    new Request("http://x/handoffs", {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    handoffs: { handoff_id: string; project_id: string | null }[];
  };
  expect(body.handoffs).toHaveLength(2);
  const projectIds = body.handoffs.map((h) => h.project_id).sort();
  expect(projectIds).toEqual(["proj-a", "proj-b"]);
});

test("GET /handoffs?agent=agent-x (no status param) returns exactly the agent-x row", async () => {
  const { services } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });

  services.handoffWriter.create({
    handoff_id: "h-x",
    ts: "2026-09-01T11:59:00.000Z",
    from: "claude",
    to: "agent-x",
    to_role: null,
    message: "m-x",
    conversation_id: "conv-1",
    project_id: null,
    triggered_by_event_id: "e-x",
  });
  services.handoffWriter.create({
    handoff_id: "h-y",
    ts: "2026-09-01T11:59:00.000Z",
    from: "claude",
    to: "agent-y",
    to_role: null,
    message: "m-y",
    conversation_id: "conv-1",
    project_id: null,
    triggered_by_event_id: "e-y",
  });

  const res = await fetchHandler(
    new Request("http://x/handoffs?agent=agent-x", {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { handoffs: { to_agent: string }[] };
  expect(body.handoffs.map((h) => h.to_agent)).toEqual(["agent-x"]);
});

test("GET /handoffs?status=pending&agent=agent-x returns exactly the agent-x row", async () => {
  const { services } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });

  services.handoffWriter.create({
    handoff_id: "h-x",
    ts: "2026-09-01T11:59:00.000Z",
    from: "claude",
    to: "agent-x",
    to_role: null,
    message: "m-x",
    conversation_id: "conv-1",
    project_id: null,
    triggered_by_event_id: "e-x",
  });
  services.handoffWriter.create({
    handoff_id: "h-y",
    ts: "2026-09-01T11:59:00.000Z",
    from: "claude",
    to: "agent-y",
    to_role: null,
    message: "m-y",
    conversation_id: "conv-1",
    project_id: null,
    triggered_by_event_id: "e-y",
  });

  const res = await fetchHandler(
    new Request("http://x/handoffs?status=pending&agent=agent-x", {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { handoffs: { to_agent: string }[] };
  expect(body.handoffs.map((h) => h.to_agent)).toEqual(["agent-x"]);
});

test("GET /handoffs?status=pending&agent=nobody returns {handoffs:[]}", async () => {
  const { services } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });

  services.handoffWriter.create({
    handoff_id: "h-x",
    ts: "2026-09-01T11:59:00.000Z",
    from: "claude",
    to: "agent-x",
    to_role: null,
    message: "m-x",
    conversation_id: "conv-1",
    project_id: null,
    triggered_by_event_id: "e-x",
  });

  const res = await fetchHandler(
    new Request("http://x/handoffs?status=pending&agent=nobody", {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { handoffs: { to_agent: string }[] };
  expect(body.handoffs).toEqual([]);
});

test("GET /handoffs?agent= (empty) returns 400 validation_error", async () => {
  const { services } = buildClaimTestServices();
  const TOKEN = "test-token";
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });

  const res = await fetchHandler(
    new Request("http://x/handoffs?agent=", { headers: { authorization: `Bearer ${TOKEN}` } }),
  );
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("validation_error");
});
