import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { createDaemonFetchHandler } from "../../src/serve.js";
import {
  routingBiasListRoute,
  routingBiasSetRoute,
  routingBiasClearRoute,
} from "../../src/routes/routing-bias.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {}
}

const NOW = "2026-05-01T12:00:00Z";

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makeServices(db: Database): Services {
  let tick = 0;
  return {
    db,
    clock: () => new Date(new Date(NOW).getTime() + tick++ * 1000),
    uuid: () => "test-uuid",
    machineId: { get: () => "test-machine" },
  } as unknown as Services;
}

describe("POST /routing/bias (set)", () => {
  let db: Database;
  let services: Services;

  beforeEach(() => {
    db = freshDb();
    services = makeServices(db);
  });

  it("creates a new bias and returns it", async () => {
    const req = new Request("http://x/routing/bias", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "agent",
        value: "alpha",
        mode: "boost",
        ttl_seconds: 3600,
        weight: 1.5,
        reason: "test",
      }),
    });
    const res = await routingBiasSetRoute(req, services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe("agent");
    expect(body.value).toBe("alpha");
    expect(body.mode).toBe("boost");
    expect(body.weight).toBe(1.5);
    expect(body.reason).toBe("test");
    expect(body.bias_id).toBeDefined();
    expect(body.expires_at).toBeDefined();
  });

  it("returns 400 on invalid scope", async () => {
    const req = new Request("http://x/routing/bias", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "invalid",
        value: "alpha",
        mode: "boost",
        ttl_seconds: 3600,
      }),
    });
    const res = await routingBiasSetRoute(req, services);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_params");
  });

  it("returns 400 on missing ttl_seconds and expires_at", async () => {
    const req = new Request("http://x/routing/bias", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "agent",
        value: "alpha",
        mode: "boost",
      }),
    });
    const res = await routingBiasSetRoute(req, services);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_params");
  });

  it("is idempotent at (scope, value, mode) key", async () => {
    const payload = {
      scope: "agent",
      value: "alpha",
      mode: "boost",
      ttl_seconds: 3600,
      weight: 1.0,
    };
    const req1 = new Request("http://x/routing/bias", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const res1 = await routingBiasSetRoute(req1, services);
    const body1 = await res1.json();

    const req2 = new Request("http://x/routing/bias", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, weight: 2.0 }),
    });
    const res2 = await routingBiasSetRoute(req2, services);
    const body2 = await res2.json();

    expect(body2.bias_id).toBe(body1.bias_id);
    expect(body2.weight).toBe(2.0);
  });
});

describe("GET /routing/bias (list)", () => {
  let db: Database;
  let services: Services;

  beforeEach(() => {
    db = freshDb();
    services = makeServices(db);
  });

  it("returns empty list when no biases", async () => {
    const req = new Request("http://x/routing/bias");
    const res = await routingBiasListRoute(req, services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.biases).toEqual([]);
  });

  it("lists active biases sorted by created_at desc with time_remaining", async () => {
    // Insert two biases
    const setReq1 = new Request("http://x/routing/bias", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "agent",
        value: "alpha",
        mode: "boost",
        ttl_seconds: 3600,
      }),
    });
    await routingBiasSetRoute(setReq1, services);

    const setReq2 = new Request("http://x/routing/bias", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "provider",
        value: "anthropic",
        mode: "exclude",
        ttl_seconds: 7200,
      }),
    });
    await routingBiasSetRoute(setReq2, services);

    const req = new Request("http://x/routing/bias");
    const res = await routingBiasListRoute(req, services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.biases).toHaveLength(2);
    expect(body.biases[0].scope).toBe("provider");
    expect(body.biases[1].scope).toBe("agent");
    expect(body.biases[0].time_remaining).toBeDefined();
    expect(typeof body.biases[0].time_remaining).toBe("string");
  });

  it("filters by scope", async () => {
    const setReq1 = new Request("http://x/routing/bias", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "agent",
        value: "alpha",
        mode: "boost",
        ttl_seconds: 3600,
      }),
    });
    await routingBiasSetRoute(setReq1, services);

    const setReq2 = new Request("http://x/routing/bias", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "provider",
        value: "anthropic",
        mode: "exclude",
        ttl_seconds: 7200,
      }),
    });
    await routingBiasSetRoute(setReq2, services);

    const req = new Request("http://x/routing/bias?scope=agent");
    const res = await routingBiasListRoute(req, services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.biases).toHaveLength(1);
    expect(body.biases[0].scope).toBe("agent");
  });

  it("filters by value", async () => {
    const setReq1 = new Request("http://x/routing/bias", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "agent",
        value: "alpha",
        mode: "boost",
        ttl_seconds: 3600,
      }),
    });
    await routingBiasSetRoute(setReq1, services);

    const setReq2 = new Request("http://x/routing/bias", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "agent",
        value: "beta",
        mode: "exclude",
        ttl_seconds: 7200,
      }),
    });
    await routingBiasSetRoute(setReq2, services);

    const req = new Request("http://x/routing/bias?value=alpha");
    const res = await routingBiasListRoute(req, services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.biases).toHaveLength(1);
    expect(body.biases[0].value).toBe("alpha");
  });

  it("excludes expired biases", async () => {
    const setReq = new Request("http://x/routing/bias", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "agent",
        value: "alpha",
        mode: "boost",
        expires_at: "2026-04-01T00:00:00Z",
      }),
    });
    await routingBiasSetRoute(setReq, services);

    const req = new Request("http://x/routing/bias");
    const res = await routingBiasListRoute(req, services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.biases).toEqual([]);
  });
});

describe("POST /routing/bias/clear", () => {
  let db: Database;
  let services: Services;

  beforeEach(() => {
    db = freshDb();
    services = makeServices(db);
  });

  it("returns 400 without confirm:true when all is set", async () => {
    const req = new Request("http://x/routing/bias/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    const res = await routingBiasClearRoute(req, services);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_params");
  });

  it("clears all biases with confirm:true", async () => {
    const setReq = new Request("http://x/routing/bias", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "agent",
        value: "alpha",
        mode: "boost",
        ttl_seconds: 3600,
      }),
    });
    await routingBiasSetRoute(setReq, services);

    const clearReq = new Request("http://x/routing/bias/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true, confirm: true }),
    });
    const res = await routingBiasClearRoute(clearReq, services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cleared_count).toBe(1);

    const listReq = new Request("http://x/routing/bias");
    const listRes = await routingBiasListRoute(listReq, services);
    const listBody = await listRes.json();
    expect(listBody.biases).toEqual([]);
  });

  it("clears by bias_id", async () => {
    const setReq = new Request("http://x/routing/bias", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "agent",
        value: "alpha",
        mode: "boost",
        ttl_seconds: 3600,
      }),
    });
    const setRes = await routingBiasSetRoute(setReq, services);
    const setBody = await setRes.json();

    const clearReq = new Request("http://x/routing/bias/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bias_id: setBody.bias_id }),
    });
    const res = await routingBiasClearRoute(clearReq, services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cleared_count).toBe(1);
  });

  it("clears by scope + value", async () => {
    const setReq = new Request("http://x/routing/bias", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "agent",
        value: "alpha",
        mode: "boost",
        ttl_seconds: 3600,
      }),
    });
    await routingBiasSetRoute(setReq, services);

    const clearReq = new Request("http://x/routing/bias/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "agent", value: "alpha" }),
    });
    const res = await routingBiasClearRoute(clearReq, services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cleared_count).toBe(1);
  });
});

describe("serve.ts wires authenticated routing bias routes", () => {
  let db: Database;
  let services: Services;

  beforeEach(() => {
    db = freshDb();
    services = makeServices(db);
  });

  it("runs full set->list->clear round-trip via HTTP", async () => {
    const handler = createDaemonFetchHandler({ services, token: "tok" });

    // Set
    const setRes = await handler(
      new Request("http://x/routing/bias", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          scope: "agent",
          value: "alpha",
          mode: "boost",
          ttl_seconds: 3600,
          weight: 1.5,
          reason: "round-trip test",
        }),
      }),
    );
    expect(setRes.status).toBe(200);
    const setBody = await setRes.json();
    expect(setBody.bias_id).toBeDefined();
    expect(setBody.weight).toBe(1.5);

    // List
    const listRes = await handler(
      new Request("http://x/routing/bias", {
        headers: { authorization: "Bearer tok" },
      }),
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.biases).toHaveLength(1);
    expect(listBody.biases[0].time_remaining).toBeDefined();

    // Clear
    const clearRes = await handler(
      new Request("http://x/routing/bias/clear", {
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({ all: true, confirm: true }),
      }),
    );
    expect(clearRes.status).toBe(200);
    const clearBody = await clearRes.json();
    expect(clearBody.cleared_count).toBe(1);

    // Verify list is empty
    const listRes2 = await handler(
      new Request("http://x/routing/bias", {
        headers: { authorization: "Bearer tok" },
      }),
    );
    const listBody2 = await listRes2.json();
    expect(listBody2.biases).toEqual([]);
  });
});
