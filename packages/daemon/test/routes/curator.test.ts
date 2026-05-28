import { expect, it, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec, applySchema } from "@penumbra/core";
import type { Services } from "@penumbra/core";
import {
  curatorPatternsListRoute,
  curatorPatternsAddRoute,
  curatorPatternsApproveRoute,
  curatorPatternsDisableRoute,
} from "../../src/routes/curator.js";
import { createBearerAuth } from "../../src/auth.js";
import type { WorkerTokenStoreLike } from "../../src/auth.js";

function makeWorkerRequest(url: string, method = "POST", body?: unknown): Request {
  const req = new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer worker-tok",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const store: WorkerTokenStoreLike = {
    lookup: (t) => (t === "worker-tok" ? { token_hash: "th1", worker_id: "w1" } : null),
  };
  const auth = createBearerAuth({ token: "shared-never-matches-this", workerTokenStore: store });
  auth(req);
  return req;
}

function makeSharedRequest(url: string, method = "POST", body?: unknown): Request {
  const token = "shared-never-matches-this";
  const req = new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const auth = createBearerAuth({ token, workerTokenStore: undefined });
  auth(req);
  return req;
}

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

let db: Database;

function makeServices(): Services {
  return { db } as unknown as Services;
}

beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 3 });
});

afterEach(() => {
  db.close();
});

function seedPattern(opts: {
  pattern_id?: string;
  pattern: string;
  status: string;
  enabled?: number;
}): void {
  db.prepare(
    `INSERT INTO curator_ephemera_patterns (pattern_id, pattern, reason, status, proposed_by, proposed_at, enabled)
     VALUES (?, ?, 'test', ?, 'test', ?, ?)`,
  ).run(
    opts.pattern_id ?? crypto.randomUUID(),
    opts.pattern,
    opts.status,
    Date.now(),
    opts.enabled ?? 0,
  );
}

it("GET /curator/patterns returns approved patterns only by default", async () => {
  seedPattern({ pattern: "URL: %", status: "approved", enabled: 1 });
  seedPattern({ pattern: "Other: %", status: "queued" });
  const res = await curatorPatternsListRoute(
    new Request("http://x/curator/patterns"),
    makeServices(),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { patterns: any[] };
  expect(body.patterns).toHaveLength(1);
  expect(body.patterns[0].pattern).toBe("URL: %");
});

it("GET /curator/patterns?status=all returns all rows", async () => {
  seedPattern({ pattern: "A", status: "approved", enabled: 1 });
  seedPattern({ pattern: "B", status: "queued" });
  const res = await curatorPatternsListRoute(
    new Request("http://x/curator/patterns?status=all"),
    makeServices(),
  );
  const body = (await res.json()) as { patterns: any[] };
  expect(body.patterns).toHaveLength(2);
});

it("GET /curator/patterns?status=invalid returns 400", async () => {
  const res = await curatorPatternsListRoute(
    new Request("http://x/curator/patterns?status=invalid"),
    makeServices(),
  );
  expect(res.status).toBe(400);
});

it("POST /curator/patterns inserts a queued pattern and returns pattern_id", async () => {
  const res = await curatorPatternsAddRoute(
    makeSharedRequest("http://x/curator/patterns", "POST", {
      pattern: "Recall: %",
      reason: "recall preamble",
    }),
    makeServices(),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { pattern_id: string };
  expect(typeof body.pattern_id).toBe("string");
  const row = db
    .prepare(`SELECT status, enabled FROM curator_ephemera_patterns WHERE pattern_id=?`)
    .get(body.pattern_id) as any;
  expect(row.status).toBe("queued");
  expect(row.enabled).toBe(0);
});

it("POST /curator/patterns rejects invalid body", async () => {
  const res = await curatorPatternsAddRoute(
    makeSharedRequest("http://x/curator/patterns", "POST", { pattern: "missing reason" }),
    makeServices(),
  );
  expect(res.status).toBe(400);
});

it("POST /curator/patterns/:id/approve flips status + enabled", async () => {
  seedPattern({ pattern_id: "p1", pattern: "test", status: "queued", enabled: 0 });
  const res = await curatorPatternsApproveRoute(
    makeSharedRequest("http://x/curator/patterns/p1/approve", "POST"),
    makeServices(),
    "p1",
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; pattern_id: string };
  expect(body.ok).toBe(true);
  expect(body.pattern_id).toBe("p1");
  const row = db
    .prepare(`SELECT status, enabled FROM curator_ephemera_patterns WHERE pattern_id='p1'`)
    .get() as any;
  expect(row.status).toBe("approved");
  expect(row.enabled).toBe(1);
});

it("POST /curator/patterns/:id/approve returns 404 for unknown id", async () => {
  const res = await curatorPatternsApproveRoute(
    makeSharedRequest("http://x/curator/patterns/missing/approve", "POST"),
    makeServices(),
    "missing",
  );
  expect(res.status).toBe(404);
});

it("POST /curator/patterns/:id/disable sets enabled=0 without changing status", async () => {
  seedPattern({ pattern_id: "p1", pattern: "test", status: "approved", enabled: 1 });
  const res = await curatorPatternsDisableRoute(
    makeSharedRequest("http://x/curator/patterns/p1/disable", "POST"),
    makeServices(),
    "p1",
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; pattern_id: string };
  expect(body.ok).toBe(true);
  const row = db
    .prepare(`SELECT status, enabled FROM curator_ephemera_patterns WHERE pattern_id='p1'`)
    .get() as any;
  expect(row.status).toBe("approved");
  expect(row.enabled).toBe(0);
});

it("POST /curator/patterns/:id/disable returns 404 for unknown id", async () => {
  const res = await curatorPatternsDisableRoute(
    makeSharedRequest("http://x/curator/patterns/missing/disable", "POST"),
    makeServices(),
    "missing",
  );
  expect(res.status).toBe(404);
});

it("POST /curator/patterns succeeds for daemon/shared principal", async () => {
  const res = await curatorPatternsAddRoute(
    makeSharedRequest("http://x/curator/patterns", "POST", {
      pattern: "Shared: %",
      reason: "test",
    }),
    makeServices(),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { pattern_id: string };
  expect(typeof body.pattern_id).toBe("string");
});

it("POST /curator/patterns rejects worker bearer with 403 admin_only", async () => {
  const res = await curatorPatternsAddRoute(
    makeWorkerRequest("http://x/curator/patterns", "POST", { pattern: "x%", reason: "test" }),
    makeServices(),
  );
  expect(res.status).toBe(403);
  const body = (await res.json()) as any;
  expect(body.error.code).toBe("admin_only");
});

it("POST /curator/patterns requires non-worker bearer for admin operations", async () => {
  const res = await curatorPatternsAddRoute(
    new Request("http://x/curator/patterns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pattern: "x%", reason: "test" }),
    }),
    makeServices(),
  );
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("admin_only");
});

it("POST /curator/patterns/:id/approve rejects worker bearer with 403", async () => {
  seedPattern({ pattern_id: "p-w", pattern: "Worker: %", status: "queued" });
  const res = await curatorPatternsApproveRoute(
    makeWorkerRequest("http://x/curator/patterns/p-w/approve"),
    makeServices(),
    "p-w",
  );
  expect(res.status).toBe(403);
  const body = (await res.json()) as any;
  expect(body.error.code).toBe("admin_only");
});

it("POST /curator/patterns/:id/disable rejects worker bearer with 403", async () => {
  seedPattern({ pattern_id: "p-w2", pattern: "Worker2: %", status: "approved", enabled: 1 });
  const res = await curatorPatternsDisableRoute(
    makeWorkerRequest("http://x/curator/patterns/p-w2/disable"),
    makeServices(),
    "p-w2",
  );
  expect(res.status).toBe(403);
  const body = (await res.json()) as any;
  expect(body.error.code).toBe("admin_only");
});

it("POST /curator/patterns approve succeeds for non-worker (shared) principal", async () => {
  seedPattern({ pattern_id: "p-ok", pattern: "Admin: %", status: "queued" });
  const res = await curatorPatternsApproveRoute(
    makeSharedRequest("http://x/curator/patterns/p-ok/approve", "POST"),
    makeServices(),
    "p-ok",
  );
  expect(res.status).toBe(200);
});
