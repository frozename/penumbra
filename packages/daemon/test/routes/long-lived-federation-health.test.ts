import { createLogger, loadSqliteVec, type Logger, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { longLivedFederationHealthRoute } from "@src/routes/long-lived-federation-health.js";

type McpPool = NonNullable<Services["mcpPool"]>;
type FederationHealth = ReturnType<McpPool["getFederationHealth"]>;

function makeSilentLog(): Logger {
  return createLogger({ component: "test", level: "silent" });
}

function makeServices(db: Database): Services {
  // federation-health route only reads `db` and `mcpPool`. Stub everything else
  // through a single laundering — Services has ~40 nominal slots none of these
  // tests reach.
  const stub = {
    db,
    storageRoot: "/tmp/penumbra-test",
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-05-11T00:00:00.000Z"),
    uuid: ((): (() => string) => {
      let n = 0;
      return () => `evt-${String(++n)}`;
    })(),
    log: makeSilentLog(),
    agentRegistry: null,
    agentRouting: null,
    providerQuotas: [],
  };
  return stub as unknown as Services;
}

function makeMcpPoolStub(getFederationHealth: () => FederationHealth): McpPool {
  return {
    callTool: () => Promise.resolve(undefined),
    listTools: () => Promise.resolve([]),
    getFederationHealth,
    shutdown: () => Promise.resolve(),
  };
}

test("GET /long-lived/federation-health returns process-wide federation snapshot", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  services.mcpPool = makeMcpPoolStub(() => ({
    registered: [{ server: "alpha", tool: "state_get", name: "alpha.state_get" }],
    skipped: [{ server: "beta", tool: "beta", reason: "tools_unavailable" }],
  }));

  const res = longLivedFederationHealthRoute(
    new Request("http://x/long-lived/federation-health"),
    services,
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    registered: [{ server: "alpha", tool: "state_get", name: "alpha.state_get" }],
    skipped: [{ server: "beta", tool: "beta", reason: "tools_unavailable" }],
  });
});
