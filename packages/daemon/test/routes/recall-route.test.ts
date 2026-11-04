import {
  buildServices,
  loadSqliteVec,
  MachineId,
  migrate,
  type RecallRequest,
  type RecallResult,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recallRoute } from "@src/routes/recall.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // Optional Homebrew SQLite is unavailable in some CI images.
  }
}

beforeAll(() => {
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
});

let n = 0;
let dirCounter = 0;

function tempServices(): Services {
  const tmpDir = mkdtempSync(join(tmpdir(), "recall-route-"));
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: tmpDir,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-05T00:00:00Z"),
    uuid: () => `id-${String(++n)}`,
    agentRegistry: ["planner"],
    worktreeRootDir: `/tmp/penumbra-recall-route-worktrees-${String(++dirCounter)}`,
    mainRepoDir: `/tmp/penumbra-recall-route-main-${String(++dirCounter)}`,
  });
  services.machineId = new MachineId({ storageRoot: tmpDir, uuid: (): string => "machine-fixed" });
  services.uuid = (): string => "recall-fixed";
  return services;
}

function readAllAuditRows(db: Database): Record<string, unknown>[] {
  return db
    .query<
      Record<string, unknown>,
      []
    >("SELECT recall_id, ts, project_id, user_id, query_text, result_ids FROM recall_audit ORDER BY rowid")
    .all();
}

function makeFixedResults(count: number): RecallResult[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `r-${String(count - i)}`,
    tier: "t1" as const,
    score: 0.9 - i * 0.1,
    fusedScore: 0.95 - i * 0.1,
    sources: ["t1"] as const,
    title: `Result ${String(count - i)}`,
    body: `Body of result ${String(count - i)}`,
    project_id: null,
    source_session_ids: [`session-${String(count - i)}`],
    created_at: `2026-05-04T${String(10 + i)}:00:00Z`,
    ts: `2026-05-04T${String(10 + i)}:00:00Z`,
  }));
}

test("invalid JSON body returns 400 with error.code 'invalid_json'", async () => {
  const services = tempServices();
  try {
    const res = await recallRoute(
      new Request("http://x/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      services,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect((body as { error: { code: string } }).error.code).toBe("invalid_json");
    expect(readAllAuditRows(services.db)).toHaveLength(0);
  } finally {
    services.db.close();
  }
});

test("body that fails schema returns 400 with error.code 'validation_error'", async () => {
  const services = tempServices();
  try {
    const res = await recallRoute(
      new Request("http://x/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "" }),
      }),
      services,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; field_errors: { path: unknown[] }[] };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.field_errors.some((e) => e.path.join(".") === "query")).toBe(true);
    expect(readAllAuditRows(services.db)).toHaveLength(0);
  } finally {
    services.db.close();
  }
});

test("privacy tags are stripped from the query before the reader sees it", async () => {
  const services = tempServices();
  const fixedResults = makeFixedResults(2);
  const calls: Record<string, unknown>[] = [];
  services.recallReader.recall = (req: RecallRequest): Promise<RecallResult[]> => {
    calls.push(req);
    return Promise.resolve(fixedResults);
  };
  try {
    const res = await recallRoute(
      new Request("http://x/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "alpha <private>secret</private>beta" }),
      }),
      services,
    );
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect((calls[0] as { query: string }).query).toBe("alpha beta");
    expect((calls[0] as { query: string }).query).not.toContain("secret");
  } finally {
    services.db.close();
  }
});

test("schema defaults are forwarded to the reader", async () => {
  const services = tempServices();
  const fixedResults = makeFixedResults(1);
  const calls: Record<string, unknown>[] = [];
  services.recallReader.recall = (req: RecallRequest): Promise<RecallResult[]> => {
    calls.push(req);
    return Promise.resolve(fixedResults);
  };
  try {
    const res = await recallRoute(
      new Request("http://x/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "x" }),
      }),
      services,
    );
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({
      query: "x",
      project_id: null,
      limit: 20,
      include_raw: false,
      include_untrusted: false,
      min_score: 0,
    });
  } finally {
    services.db.close();
  }
});

test("response returns 200 with results from the reader", async () => {
  const services = tempServices();
  const fixedResults = makeFixedResults(2);
  services.recallReader.recall = (): Promise<RecallResult[]> => Promise.resolve(fixedResults);
  try {
    const res = await recallRoute(
      new Request("http://x/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      }),
      services,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: RecallResult[] };
    expect(body.results).toEqual(fixedResults);
  } finally {
    services.db.close();
  }
});

test("audit row has correct identity fields", async () => {
  const services = tempServices();
  const fixedResults = makeFixedResults(2);
  services.recallReader.recall = (): Promise<RecallResult[]> => Promise.resolve(fixedResults);
  try {
    await recallRoute(
      new Request("http://x/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      }),
      services,
    );
    const rows = readAllAuditRows(services.db);
    expect(rows).toHaveLength(1);
    const row = rows.at(0)!;
    expect(row.recall_id).toBe("recall-fixed");
    expect(row.ts).toBe("2026-05-05T00:00:00.000Z");
    expect(row.user_id).toBe("machine-fixed");
  } finally {
    services.db.close();
  }
});

test("audit result_ids is the JSON string of reader result ids", async () => {
  const services = tempServices();
  const fixedResults = makeFixedResults(2);
  services.recallReader.recall = (): Promise<RecallResult[]> => Promise.resolve(fixedResults);
  try {
    await recallRoute(
      new Request("http://x/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "test" }),
      }),
      services,
    );
    const rows = readAllAuditRows(services.db);
    expect(rows).toHaveLength(1);
    const row = rows.at(0)!;
    expect(row.result_ids).toBe('["r-2","r-1"]');
  } finally {
    services.db.close();
  }
});

test("audit project_id reflects the request body", async () => {
  const services = tempServices();
  services.recallReader.recall = (): Promise<RecallResult[]> =>
    Promise.resolve(makeFixedResults(1));
  try {
    await recallRoute(
      new Request("http://x/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "test", project_id: "proj-a" }),
      }),
      services,
    );
    const rows = readAllAuditRows(services.db);
    expect(rows).toHaveLength(1);
    const row = rows.at(0)!;
    expect(row.project_id).toBe("proj-a");
  } finally {
    services.db.close();
  }
});

test("audit query_text stores the stripped query", async () => {
  const services = tempServices();
  services.recallReader.recall = (): Promise<RecallResult[]> =>
    Promise.resolve(makeFixedResults(1));
  try {
    await recallRoute(
      new Request("http://x/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "alpha <private>secret</private>beta" }),
      }),
      services,
    );
    const rows = readAllAuditRows(services.db);
    expect(rows).toHaveLength(1);
    const row = rows.at(0)!;
    expect(row.query_text).toBe("alpha beta");
  } finally {
    services.db.close();
  }
});
