import { loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildWorkflowCtx, type BuildWorkflowCtxDeps } from "../src/ctx.js";

type ProgressRow = Record<string, unknown>;

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makeServices(db: Database, overrides?: { uuid?: () => string }): Services {
  return {
    db,
    log: {
      error: (): undefined => undefined,
      warn: (): undefined => undefined,
      info: (): undefined => undefined,
      debug: (): undefined => undefined,
      trace: (): undefined => undefined,
      fatal: (): undefined => undefined,
    },
    clock: (): Date => new Date("2026-04-26T00:00:00.000Z"),
    uuid: overrides?.uuid ?? ((): string => "event-1"),
    handoffReader: {
      getRootForConversation: () => null,
      getLatestForConversation: () => null,
    },
    chainReader: {
      getResponses: (): unknown[] => [],
    },
  } as unknown as Services;
}

function progressRows(db: Database): ProgressRow[] {
  return db
    .query("SELECT * FROM t0_events WHERE event_type = 'workflow.progress'")
    .all() as ProgressRow[];
}

function baseDeps(db: Database): BuildWorkflowCtxDeps {
  return {
    services: makeServices(db),
    cwd: "/tmp/cwd",
    storageRoot: "/tmp/storage",
    project: "proj-1",
    agentchatConfig: {},
    workflowRunId: "wfrun-1",
    progressIdentity: {
      project: "proj-1",
      sessionId: "session-1",
      userId: "penumbra",
      machineId: "test-machine",
      workflowRunId: "wfrun-1",
    },
    chainStart: () =>
      Promise.resolve(
        new Response(JSON.stringify({ conversation_id: "conv-1", handoff_id: "hand-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    now: () => new Date("2026-04-26T00:00:00.000Z").getTime(),
  };
}

test("progress writes a workflow.progress t0 event with identity and no usage", () => {
  const db = freshDb();
  const ctx = buildWorkflowCtx(baseDeps(db));

  ctx.progress!("step one", { phase: 1 });

  const rows = progressRows(db);
  expect(rows.length).toBe(1);
  const row = rows[0];
  expect(row).not.toBeUndefined();
  expect(row.event_type).toBe("workflow.progress");
  expect(row.project_id).toBe("proj-1");
  expect(row.session_id).toBe("session-1");
  expect(row.user_id).toBe("penumbra");
  expect(row.machine_id).toBe("test-machine");
  expect(row.source).toBe("agentchat");
  expect(row.lane).toBe("local");
  expect(row.provider).toBeNull();
  expect(row.model).toBeNull();
  expect(row.tokens_in).toBeNull();
  expect(row.tokens_out).toBeNull();
  expect(row.cost_usd).toBeNull();
  expect(row.latency_ms).toBeNull();
  expect(row.request_id).toBeNull();
  expect(row.ts).toBe("2026-04-26T00:00:00.000Z");
  expect(row.ingest_ts).toBe("2026-04-26T00:00:00.000Z");

  const payload = JSON.parse(row.payload_json as string) as Record<string, unknown>;
  expect(payload.workflow_run_id).toBe("wfrun-1");
  expect(payload.message).toBe("step one");
  expect(payload.meta).toEqual({ phase: 1 });
  expect(row.payload_summary).toBe("step one");
  ctx.dispose();
});

test("progress is an own enumerable property and survives executor spread", () => {
  const db = freshDb();
  const ctx = buildWorkflowCtx(baseDeps(db));

  expect(Object.hasOwn(ctx, "progress")).toBe(true);
  expect(typeof ctx.progress).toBe("function");

  const context = {
    ...ctx,
    fileWrite: (relativePath: string, body: string): Promise<string> =>
      Promise.resolve(`${relativePath}:${body}`),
  };
  expect(Object.hasOwn(context, "progress")).toBe(true);
  expect(typeof context.progress).toBe("function");

  context.progress!("spread step");

  const rows = progressRows(db);
  expect(rows.length).toBe(1);
  const payload = JSON.parse(rows[0]?.payload_json as string) as Record<string, unknown>;
  expect(payload.message).toBe("spread step");
  ctx.dispose();
});

test("progress writes to services.db, not the readonly ctx.db handle", () => {
  const root = mkdtempSync(join(tmpdir(), "wfctx-progress-ro-"));
  try {
    const db = freshDb();
    const services = makeServices(db);
    const storageRoot = join(root, "storage");
    mkdirSync(storageRoot, { recursive: true });
    const dbPath = join(storageRoot, "db.sqlite");
    const seedDb = new Database(dbPath);
    loadSqliteVec(seedDb);
    migrate(seedDb, { embeddingDim: 384 });
    seedDb.close();
    const ctx = buildWorkflowCtx({
      ...baseDeps(db),
      services,
      cwd: join(root, "repo"),
      storageRoot,
    });

    ctx.progress!("independent");

    expect(progressRows(db).length).toBe(1);

    const ctxDb = ctx.db();
    const ctxRows = ctxDb
      .query("SELECT * FROM t0_events WHERE event_type = 'workflow.progress'")
      .all() as ProgressRow[];
    expect(ctxRows.length).toBe(0);

    ctx.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("progress is a no-op when the workflow run id is missing", () => {
  const db = freshDb();
  const ctx = buildWorkflowCtx({
    ...baseDeps(db),
    workflowRunId: null,
    progressIdentity: {
      ...baseDeps(db).progressIdentity,
      workflowRunId: null,
    },
  });

  ctx.progress!("no-op");

  expect(progressRows(db).length).toBe(0);
  ctx.dispose();
});

test("progress does not throw when the writable db is closed", () => {
  const db = freshDb();
  db.close();
  const ctx = buildWorkflowCtx({
    ...baseDeps(db),
    services: makeServices(db),
  });

  expect(() => {
    ctx.progress!("closed-db");
  }).not.toThrow();
  ctx.dispose();
});

test("progress does not throw on cyclic metadata and records meta as null", () => {
  const db = freshDb();
  const ctx = buildWorkflowCtx(baseDeps(db));

  const meta: Record<string, unknown> = { a: 1 };
  meta.self = meta;

  expect(() => {
    ctx.progress!("cyclic", meta);
  }).not.toThrow();

  const rows = progressRows(db);
  expect(rows.length).toBe(1);
  const payload = JSON.parse(rows[0]?.payload_json as string) as Record<string, unknown>;
  expect(payload.message).toBe("cyclic");
  expect(payload.workflow_run_id).toBe("wfrun-1");
  expect(payload.meta).toBeNull();
  ctx.dispose();
});

test("progress does not throw when the db prepare fails", () => {
  const db = freshDb();
  const throwingDb = new Proxy<Database>(db, {
    get(target: Database, prop: string | symbol): unknown {
      if (prop === "prepare") {
        return (): never => {
          throw new Error("disk full");
        };
      }
      return (target as Record<string, unknown>)[prop as string];
    },
  });
  const ctx = buildWorkflowCtx({
    ...baseDeps(db),
    services: makeServices(throwingDb),
  });

  expect(() => {
    ctx.progress!("write-fail");
  }).not.toThrow();
  ctx.dispose();
});
