import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildServices, loadSqliteVec, migrate, type Services, WorkerTokenStore } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { createDaemonFetchHandler } from "../../src/serve.js";
import { createHash } from "node:crypto";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/register-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-20T10:00:00Z"),
    uuid: (() => {
      let n = 0;
      return () => `e-${++n}`;
    })(),
  });
}

const SHARED_TOKEN = "shared-sec";

test("POST /worker/register with shared bearer returns 200 + worker_token", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  const res = await fetchHandler(new Request("http://x/worker/register", {
    method: "POST",
    headers: { 
        "Authorization": `Bearer ${SHARED_TOKEN}`,
        "Content-Type": "application/json"
    },
    body: JSON.stringify({ worker_id: "W-A", metadata: { host: "mac-mini" } }),
  }));

  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.worker_id).toBe("W-A");
  expect(typeof body.worker_token).toBe("string");
  expect(body.worker_token.length).toBeGreaterThan(10);

  // Verify DB
  
  
  const hash = createHash("sha256").update(body.worker_token).digest("hex");
  
  
  

  const row = services.db.query("SELECT * FROM worker_tokens WHERE token_hash = ?").get(hash) as any;
  expect(row).toBeDefined();
  expect(row.worker_id).toBe("W-A");
  expect(row.metadata_json).toBe(JSON.stringify({ host: "mac-mini" }));
});

test("POST /worker/register without metadata persists metadata_json NULL", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  const res = await fetchHandler(new Request("http://x/worker/register", {
    method: "POST",
    headers: { 
        "Authorization": `Bearer ${SHARED_TOKEN}`,
        "Content-Type": "application/json"
    },
    body: JSON.stringify({ worker_id: "W-B" }),
  }));

  expect(res.status).toBe(200);
  const body = await res.json() as any;
  
  
  const hash = createHash("sha256").update(body.worker_token).digest("hex");
  
  
  

  const row = services.db.query("SELECT * FROM worker_tokens WHERE token_hash = ?").get(hash) as any;
  expect(row.metadata_json).toBe(null);
});

test("POST /worker/register without Authorization returns 401", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  const res = await fetchHandler(new Request("http://x/worker/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ worker_id: "W-A" }),
  }));

  expect(res.status).toBe(401);
});

test("POST /worker/register with unknown bearer returns 401", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  const res = await fetchHandler(new Request("http://x/worker/register", {
    method: "POST",
    headers: { 
        "Authorization": "Bearer wrong-secret",
        "Content-Type": "application/json"
    },
    body: JSON.stringify({ worker_id: "W-A" }),
  }));

  expect(res.status).toBe(401);
  
  const count = services.db.query("SELECT COUNT(*) as n FROM worker_tokens").get() as any;
  expect(count.n).toBe(0);
});

test("POST /worker/register with a worker token returns 403 shared_bearer_required_for_registration", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  // 1. Register W-A
  const res1 = await fetchHandler(new Request("http://x/worker/register", {
    method: "POST",
    headers: { 
        "Authorization": `Bearer ${SHARED_TOKEN}`,
        "Content-Type": "application/json"
    },
    body: JSON.stringify({ worker_id: "W-A" }),
  }));
  const body1 = await res1.json() as any;
  const workerToken = body1.worker_token;

  // 2. Try to register W-B using W-A's token
  const res2 = await fetchHandler(new Request("http://x/worker/register", {
    method: "POST",
    headers: { 
        "Authorization": `Bearer ${workerToken}`,
        "Content-Type": "application/json"
    },
    body: JSON.stringify({ worker_id: "W-B" }),
  }));

  expect(res2.status).toBe(403);
  const body2 = await res2.json() as any;
  expect(body2.error.code).toBe("shared_bearer_required_for_registration");
});

test("Two register calls for the same worker_id produce distinct tokens; both rows present", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  const req = (id: string) => new Request("http://x/worker/register", {
    method: "POST",
    headers: { 
        "Authorization": `Bearer ${SHARED_TOKEN}`,
        "Content-Type": "application/json"
    },
    body: JSON.stringify({ worker_id: id }),
  });

  const res1 = await fetchHandler(req("W-A"));
  const body1 = await res1.json() as any;

  const res2 = await fetchHandler(req("W-A"));
  const body2 = await res2.json() as any;

  expect(body1.worker_token).not.toBe(body2.worker_token);

  const count = services.db.query("SELECT COUNT(*) as n FROM worker_tokens WHERE worker_id = 'W-A'").get() as any;
  expect(count.n).toBe(2);
});

test("POST /worker/register with malformed JSON returns 400 invalid_json", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  const res = await fetchHandler(new Request("http://x/worker/register", {
    method: "POST",
    headers: { 
        "Authorization": `Bearer ${SHARED_TOKEN}`,
        "Content-Type": "application/json"
    },
    body: "{{{not json}}}",
  }));

  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body.error.code).toBe("invalid_json");
});

test("POST /worker/register with missing worker_id returns 400 validation_error", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

  const res = await fetchHandler(new Request("http://x/worker/register", {
    method: "POST",
    headers: { 
        "Authorization": `Bearer ${SHARED_TOKEN}`,
        "Content-Type": "application/json"
    },
    body: JSON.stringify({ metadata: {} }),
  }));

  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body.error.code).toBe("validation_error");
});
