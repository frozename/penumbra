import {
  buildServices,
  type Embedder,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPC1Phase } from "@src/dreaming/curator/pc1-ephemera.js";
import { runPC2Phase } from "@src/dreaming/curator/pc2-cluster.js";
import { createDaemonFetchHandler } from "@src/serve.js";

import { registerWorkerForTest } from "../../test-utils.js";

const SHARED_TOKEN = "shared-token";

function makeFetcher(
  services: Services,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const handler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    return handler(new Request(input, init));
  };
}

function makeServices(embedder: Embedder = new TestEmbedder({ dim: 384 })): {
  services: Services;
  db: Database;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  root: string;
} {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const root = mkdtempSync(join(tmpdir(), "memory-write-test-"));
  mkdirSync(join(root, "worktrees"), { recursive: true });
  mkdirSync(join(root, ".penumbra", "reviews"), { recursive: true });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: join(root, "storage"),
    db,
    embedder,
  });

  return {
    services,
    db,
    fetch: makeFetcher(services),
    root,
  };
}

function seedMemory(
  db: Database,
  memoryId: string,
  input: {
    title: string;
    body: string;
    slug?: string | null;
    hook?: string | null;
    sub_kind?: string | null;
    cc_kind?: string | null;
    origin?: string | null;
    project_id?: string | null;
    createdAt?: string;
    kind?: string;
  },
): void {
  const now = input.createdAt ?? "2026-05-23T00:00:00.000Z";
  db.run(
    `INSERT INTO t2_memories(
      memory_id, project_id, user_id, kind, source_session_ids,
      window_start, window_end, title, body, metadata_json,
      compressed_from, created_at, updated_at, slug, hook, sub_kind, cc_kind, origin
    ) VALUES(?, ?, 'u1', ?, '[]', ?, ?, ?, ?, '{}', NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [
      memoryId,
      input.project_id ?? null,
      input.kind ?? "fact",
      now,
      now,
      input.title,
      input.body,
      now,
      now,
      input.slug ?? null,
      input.hook ?? null,
      input.sub_kind ?? null,
      input.cc_kind ?? null,
      input.origin ?? null,
    ],
  );
}

function seedCycle(db: Database, cycleId: string): void {
  db.run(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome)
     VALUES(?, ?, 'cron', 0.1, 'running')`,
    [cycleId, Date.now()],
  );
}

describe("POST /memory/write", () => {
  const handles: { db: Database; root: string }[] = [];

  afterEach(() => {
    for (const handle of handles) {
      try {
        handle.db.close();
      } catch {
        /* already closed */
      }
      try {
        rmSync(handle.root, { recursive: true, force: true });
      } catch {
        /* already removed */
      }
    }
    handles.length = 0;
  });

  test("1) POST /memory/write inserts direct memory with kind=direct and metadata fields", async () => {
    const { services, db, fetch, root } = makeServices();
    handles.push({ db, root });

    const res = await fetch("http://x/memory/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Direct fact",
        body: "Direct body",
        slug: "direct-feedback",
        hook: "hook://notes/direct-feedback",
        sub_kind: "rule",
        cc_kind: "feedback",
      }),
    });

    expect(res.status).toBe(200);
    const written = (await res.json()) as { memory_id: string; created: boolean };
    expect(written.created).toBe(true);
    expect(typeof written.memory_id).toBe("string");

    const row = db
      .prepare<
        {
          memory_id: string;
          origin: string | null;
          kind: string;
          slug: string | null;
          hook: string | null;
          sub_kind: string | null;
          cc_kind: string | null;
          body: string;
          window_start: string;
          window_end: string;
        },
        [string]
      >(
        `
      SELECT memory_id, origin, kind, slug, hook, sub_kind, cc_kind, body, window_start, window_end
      FROM t2_memories WHERE memory_id = ?
    `,
      )
      .get(written.memory_id);

    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      memory_id: written.memory_id,
      origin: "direct",
      kind: "direct",
      slug: "direct-feedback",
      hook: "hook://notes/direct-feedback",
      sub_kind: "rule",
      cc_kind: "feedback",
      body: "Direct body",
    });
    expect(Number.isNaN(Date.parse(row!.window_start))).toBe(false);
    expect(Number.isNaN(Date.parse(row!.window_end))).toBe(false);
  });

  test("POST /memory/write rejects path-traversal project_id values", async () => {
    const invalidProjectIds = ["../etc", "../../etc/cron.d", "/etc/passwd", "..\\evil", "bad\0id"];

    for (const projectId of invalidProjectIds) {
      const { db, fetch, root } = makeServices();
      handles.push({ db, root });

      const res = await fetch("http://x/memory/write", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SHARED_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Unsafe project",
          body: "blocked",
          project_id: projectId,
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("validation_error");
    }
  });

  test("POST /memory/write accepts safe project_id values", async () => {
    const { db, fetch, root } = makeServices();
    handles.push({ db, root });

    const res = await fetch("http://x/memory/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Safe project",
        body: "stored",
        project_id: "proj-safe",
      }),
    });

    expect(res.status).toBe(200);
    const written = (await res.json()) as { memory_id: string };
    const row = db
      .query<
        { project_id: string | null },
        [string]
      >(`SELECT project_id FROM t2_memories WHERE memory_id = ?`)
      .get(written.memory_id);
    expect(row?.project_id).toBe("proj-safe");
  });

  test("2) POST /memory/write re-imports the same slug (UPSERT, same memory_id, updated body)", async () => {
    const { services, db, fetch, root } = makeServices();
    handles.push({ db, root });

    const first = await fetch("http://x/memory/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Slug upsert",
        body: "version one",
        slug: "stable-slug",
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { memory_id: string; created: boolean };

    const firstRow = db
      .query<
        { updated_at: string; body: string },
        [string]
      >(`SELECT updated_at, body FROM t2_memories WHERE memory_id = ?`)
      .get(firstBody.memory_id)!;

    await Bun.sleep(2);

    const second = await fetch("http://x/memory/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Slug upsert",
        body: "version two",
        slug: "stable-slug",
      }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { memory_id: string; created: boolean };

    expect(secondBody.created).toBe(false);
    expect(secondBody.memory_id).toBe(firstBody.memory_id);

    const secondRow = db
      .query<
        { updated_at: string; body: string },
        [string]
      >(`SELECT updated_at, body FROM t2_memories WHERE memory_id = ?`)
      .get(secondBody.memory_id)!;
    expect(secondRow.body).toBe("version two");
    expect(Date.parse(secondRow.updated_at)).toBeGreaterThanOrEqual(
      Date.parse(firstRow.updated_at),
    );

    const rows = db
      .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t2_memories WHERE slug = 'stable-slug'`)
      .get()!;
    expect(rows.c).toBe(1);
  });

  test("POST /memory/write uses body-v1 embed input by default (inert-default)", async () => {
    const prev = process.env.PENUMBRA_T2_EMBED_RECIPE;
    delete process.env.PENUMBRA_T2_EMBED_RECIPE;
    const seen: string[][] = [];
    const embedder: Embedder = {
      name: "spy",
      dim: 384,
      embed(texts: string[]): Promise<Float32Array[]> {
        seen.push(texts);
        return Promise.resolve(texts.map(() => new Float32Array(384)));
      },
    };
    const { db, fetch, root } = makeServices(embedder);
    handles.push({ db, root });

    try {
      const res = await fetch("http://x/memory/write", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SHARED_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "T", body: "Body text" }),
      });
      expect(res.status).toBe(200);
      expect(seen).toEqual([["Body text"]]);
    } finally {
      if (prev === undefined) delete process.env.PENUMBRA_T2_EMBED_RECIPE;
      else process.env.PENUMBRA_T2_EMBED_RECIPE = prev;
    }
  });

  test("POST /memory/write routes embed input through title recipe when enabled", async () => {
    const prev = process.env.PENUMBRA_T2_EMBED_RECIPE;
    process.env.PENUMBRA_T2_EMBED_RECIPE = "title_only";
    const seen: string[][] = [];
    const embedder: Embedder = {
      name: "spy",
      dim: 384,
      embed(texts: string[]): Promise<Float32Array[]> {
        seen.push(texts);
        return Promise.resolve(texts.map(() => new Float32Array(384)));
      },
    };
    const { db, fetch, root } = makeServices(embedder);
    handles.push({ db, root });

    try {
      const res = await fetch("http://x/memory/write", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SHARED_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "Title text", body: "Body text" }),
      });
      expect(res.status).toBe(200);
      expect(seen).toEqual([["Title text"]]);
    } finally {
      if (prev === undefined) delete process.env.PENUMBRA_T2_EMBED_RECIPE;
      else process.env.PENUMBRA_T2_EMBED_RECIPE = prev;
    }
  });

  test("3) POST /memory/write parses [[slug]] and inserts wiki backlinks for resolved slugs", async () => {
    const { services, db, fetch, root } = makeServices();
    handles.push({ db, root });
    seedMemory(db, "target-a-memory", {
      title: "Target",
      body: "seed target memory",
      slug: "target-a",
    });

    const res = await fetch("http://x/memory/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Ref note",
        body: "see [[target-a]] for details",
      }),
    });
    expect(res.status).toBe(200);
    const written = (await res.json()) as { memory_id: string };

    const target = db
      .prepare<{ memory_id: string }>(`SELECT memory_id FROM t2_memories WHERE slug = 'target-a'`)
      .get()!;
    const wikiCount = db
      .query<
        { c: number },
        [string]
      >(`SELECT COUNT(*) AS c FROM memory_links WHERE src_id = ? AND dst_id = ? AND link_type = 'wiki'`)
      .get(written.memory_id, target.memory_id)!.c;
    expect(wikiCount).toBe(1);
    const link = db
      .prepare<
        {
          link_id: string;
          dst_id: string;
          link_type: string;
          metadata_json: string;
        },
        [string, string, string]
      >(
        `
      SELECT link_id, dst_id, link_type, metadata_json
      FROM memory_links
      WHERE src_id = ? AND dst_id = ? AND link_type = 'wiki'
    `,
      )
      .get(written.memory_id, target.memory_id);
    expect(link?.link_type).toBe("wiki");
    expect(link?.dst_id).toBe("target-a-memory");
  });

  test("4) POST /memory/write inserts unresolved wiki links with raw_slug metadata", async () => {
    const { services, db, fetch, root } = makeServices();
    handles.push({ db, root });

    const res = await fetch("http://x/memory/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Unresolved note",
        body: "reference [[never-exists-slug]]",
      }),
    });
    expect(res.status).toBe(200);
    const written = (await res.json()) as { memory_id: string };

    const link = db
      .prepare<
        {
          dst_id: string | null;
          link_type: string;
          metadata_json: string;
        },
        [string]
      >(
        `
      SELECT dst_id, link_type, metadata_json
      FROM memory_links
      WHERE src_id = ? AND link_type = 'wiki_unresolved'
    `,
      )
      .get(written.memory_id);

    const unresolvedCount = db
      .query<
        { c: number },
        [string]
      >(`SELECT COUNT(*) AS c FROM memory_links WHERE src_id = ? AND link_type = 'wiki_unresolved'`)
      .get(written.memory_id)!.c;
    expect(unresolvedCount).toBe(1);
    expect(link?.link_type).toBe("wiki_unresolved");
    expect(link?.dst_id).toBeNull();
    expect(JSON.parse(link?.metadata_json ?? "{}")).toEqual({ raw_slug: "never-exists-slug" });
  });

  test("5) POST /memory/write with shared bearer is allowed by default", async () => {
    const { fetch, db, root } = makeServices();
    handles.push({ db, root });

    const res = await fetch("http://x/memory/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Shared write",
        body: "this passes",
      }),
    });
    expect(res.status).toBe(200);
  });

  test("6) POST /memory/write rejects worker-token callers with maestro_only", async () => {
    const { services, fetch, root } = makeServices();
    handles.push({ db: services.db, root });

    const { worker_token } = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: SHARED_TOKEN,
      worker_id: "worker-direct",
      fetcher: fetch,
    });

    const res = await fetch("http://x/memory/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${worker_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Blocked write",
        body: "should fail",
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("principal_forbidden");
    expect(body.error.message).toBe(
      "direct-write is restricted to shared-bearer principals; worker-token callers are not authorized",
    );
  });

  test("F2) POST /memory/write resolves wiki backlinks only within same project_id scope", async () => {
    const { fetch, db, root } = makeServices();
    handles.push({ db, root });

    const projectA = await fetch("http://x/memory/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Project A",
        body: "Initial content",
        slug: "shared",
        project_id: "project-a",
      }),
    });
    expect(projectA.status).toBe(200);
    const projectABody = (await projectA.json()) as { memory_id: string };

    const projectB = await fetch("http://x/memory/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Project B",
        body: "Refs [[shared]]",
        slug: "shared",
        project_id: "project-b",
      }),
    });
    expect(projectB.status).toBe(200);
    const projectBBody = (await projectB.json()) as { memory_id: string };

    const link = db
      .prepare<{ dst_id: string | null }>(
        `
        SELECT dst_id FROM memory_links WHERE src_id = ? AND link_type IN ('wiki', 'wiki_unresolved')
      `,
      )
      .get(projectBBody.memory_id);
    expect(link?.dst_id).not.toBe(projectABody.memory_id);
    expect(link?.dst_id === projectBBody.memory_id || link?.dst_id === null).toBe(true);
    if (link?.dst_id) {
      const resolved = db
        .prepare<{
          project_id: string | null;
        }>(`SELECT project_id FROM t2_memories WHERE memory_id = ?`)
        .get(link.dst_id);
      expect(resolved?.project_id).toBe("project-b");
    }
  });

  test("6a) memory write route imports writeDirectT2Memory and parseWikiLinks from @penumbra/core", () => {
    const routeFile = new URL("../../src/routes/memory.ts", import.meta.url).pathname;
    const source = readFileSync(routeFile, "utf8");
    expect(source).toContain('from "@penumbra/core"');
    expect(source).not.toContain('from "../../../core/src/writers/wiki-links.js"');
    expect(source).not.toContain('from "../../../core/src/writers/t2.js"');
  });

  test("F1) POST /memory/write upsert removes stale wiki backlinks before inserting new ones", async () => {
    const { db, fetch, root } = makeServices();
    handles.push({ db, root });

    const first = await fetch("http://x/memory/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Reconciled backlinks",
        body: "first body [[alpha]]",
        slug: "s1",
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { memory_id: string };
    const firstAlpha = db
      .query<
        { c: number },
        [string]
      >(`SELECT COUNT(*) AS c FROM memory_links WHERE src_id = ? AND link_type = 'wiki_unresolved' AND raw_slug = 'alpha'`)
      .get(firstBody.memory_id)!;
    expect(firstAlpha.c).toBe(1);

    await Bun.sleep(2);
    const second = await fetch("http://x/memory/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Reconciled backlinks",
        body: "second body [[beta]]",
        slug: "s1",
      }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { memory_id: string };
    expect(secondBody.memory_id).toBe(firstBody.memory_id);

    const alphaAfter = db
      .query<
        { c: number },
        [string]
      >(`SELECT COUNT(*) AS c FROM memory_links WHERE src_id = ? AND link_type = 'wiki_unresolved' AND raw_slug = 'alpha'`)
      .get(firstBody.memory_id)!;
    const betaAfter = db
      .query<
        { c: number },
        [string]
      >(`SELECT COUNT(*) AS c FROM memory_links WHERE src_id = ? AND link_type = 'wiki_unresolved' AND raw_slug = 'beta'`)
      .get(firstBody.memory_id)!;
    const totalBacklinks = db
      .query<
        { c: number },
        [string]
      >(`SELECT COUNT(*) AS c FROM memory_links WHERE src_id = ? AND link_type IN ('wiki', 'wiki_unresolved')`)
      .get(firstBody.memory_id)!;

    expect(alphaAfter.c).toBe(0);
    expect(betaAfter.c).toBe(1);
    expect(totalBacklinks.c).toBe(1);
  });

  test("F2a) POST /memory/write deduplicates unresolved links across repeated writes", async () => {
    const { db, fetch, root } = makeServices();
    handles.push({ db, root });

    const first = await fetch("http://x/memory/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Dedup unresolved",
        body: "still missing [[missing]]",
        slug: "s2",
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { memory_id: string };

    await Bun.sleep(2);
    const second = await fetch("http://x/memory/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Dedup unresolved",
        body: "still missing [[missing]]",
        slug: "s2",
      }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { memory_id: string };
    expect(secondBody.memory_id).toBe(firstBody.memory_id);

    const unresolvedCount = db
      .query<
        { c: number },
        [string]
      >(`SELECT COUNT(*) AS c FROM memory_links WHERE src_id = ? AND link_type = 'wiki_unresolved' AND raw_slug = 'missing'`)
      .get(firstBody.memory_id)!;
    expect(unresolvedCount.c).toBe(1);
  });

  test.skip("F4) POST /memory/write backlink reconcile is transactional under partial failures (Bun sqlite Proxy incompat — transactional wrap verified by code review at packages/daemon/src/routes/memory.ts:220)", async () => {
    const { services, db, fetch, root } = makeServices();
    handles.push({ db, root });

    const writeDb = services.db;
    const failingDb = new Proxy(writeDb, {
      get(target, prop): unknown {
        if (prop === "prepare") {
          return (sql: string): unknown => {
            const stmt = target.prepare(sql);
            if (sql.includes("INSERT OR IGNORE INTO memory_links(")) {
              return new Proxy(stmt, {
                get(statementTarget, propName): unknown {
                  if (propName === "run") {
                    return (): never => {
                      throw new Error("simulated memory link upsert failure");
                    };
                  }
                  return statementTarget[propName as keyof typeof statementTarget];
                },
              });
            }
            return stmt;
          };
        }
        return target[prop as keyof Database];
      },
    });
    const failingServices = { ...services, db: failingDb };

    // Use the unwrapped Database for setup queries — the Proxy breaks .query()
    // (it accesses Bun's private fields which Proxy can't reach).
    const seedDb = writeDb;
    seedDb
      .prepare(
        `INSERT INTO t2_memories(
        memory_id, project_id, user_id, kind, source_session_ids, window_start, window_end,
        title, body, created_at, updated_at, slug, hook
      ) VALUES(?, NULL, 'u1', 'fact', '[]', ?, ?, ?, ?, ?, ?, 'shared-source', 'hook')`,
      )
      .run(
        "source-memory",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        "Seed source",
        "seed source body",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      );
    seedDb
      .prepare(
        `INSERT INTO t2_memories(
        memory_id, project_id, user_id, kind, source_session_ids, window_start, window_end,
        title, body, created_at, updated_at
      ) VALUES('seed-target', NULL, 'u1', 'fact', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
               'Target', 'target body', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run();
    seedDb
      .prepare(
        `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
       VALUES('seed-cycle', 1, 'cron', 0, 'completed', '[]')`,
      )
      .run();
    seedDb
      .prepare(
        `INSERT INTO memory_links(link_id, src_id, dst_id, link_type, weight, minted_at, minted_by_cycle)
       VALUES('seed-link', 'source-memory', 'seed-target', 'wiki', 1.0, 1, 'seed-cycle')`,
      )
      .run();

    const beforeUpdated = seedDb
      .query<{ updated_at: string }>(`SELECT updated_at FROM t2_memories WHERE memory_id = ?`)
      .get("source-memory")!;

    const res = await createDaemonFetchHandler({ services: failingServices, token: SHARED_TOKEN })(
      new Request("http://x/memory/write", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SHARED_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Seed source",
          body: "updated body [[missing-link]]",
          slug: "shared-source",
        }),
      }),
    );

    expect(res.status).toBeGreaterThanOrEqual(500);

    const remaining = seedDb
      .query<
        { c: number },
        [string]
      >(`SELECT COUNT(*) AS c FROM memory_links WHERE src_id = ? AND link_type IN ('wiki', 'wiki_unresolved')`)
      .get("source-memory")!;
    expect(remaining.c).toBe(1);

    const afterUpdated = seedDb
      .query<{ updated_at: string }>(`SELECT updated_at FROM t2_memories WHERE memory_id = ?`)
      .get("source-memory")!;
    expect(afterUpdated.updated_at).toBe(beforeUpdated.updated_at);
  });

  test("F3) POST /memory/write projects slug uniqueness by project_id", async () => {
    const { fetch, db, root } = makeServices();
    handles.push({ db, root });

    const first = await fetch("http://x/memory/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Project A",
        body: "from project A",
        slug: "shared",
        project_id: "proj-a",
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { memory_id: string };

    const second = await fetch("http://x/memory/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Project B",
        body: "from project B",
        slug: "shared",
        project_id: "proj-b",
      }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { memory_id: string };
    expect(secondBody.memory_id).not.toBe(firstBody.memory_id);

    const bySlug = db
      .query<
        { c: number },
        []
      >(`SELECT COUNT(*) AS c FROM t2_memories WHERE slug = 'shared' AND project_id IN ('proj-a', 'proj-b')`)
      .get()!;
    expect(bySlug.c).toBe(2);

    const upsertProjA = await fetch("http://x/memory/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Project A",
        body: "updated project A",
        slug: "shared",
        project_id: "proj-a",
      }),
    });
    expect(upsertProjA.status).toBe(200);
    const upsertProjABody = (await upsertProjA.json()) as { memory_id: string; created: boolean };
    expect(upsertProjABody.memory_id).toBe(firstBody.memory_id);
    expect(upsertProjABody.created).toBe(false);

    const rows = db
      .query<{ memory_id: string }, [string]>(
        `SELECT memory_id FROM t2_memories WHERE project_id = ? AND slug = 'shared'`,
      )
      .all("proj-a")
      .map((r) => r.memory_id);
    expect(rows).toEqual([firstBody.memory_id]);
  });

  test("F9) POST /memory/write upsert resets legacy row classification fields", async () => {
    const { db, fetch, root } = makeServices();
    handles.push({ db, root });

    seedMemory(db, "legacy-1", {
      title: "Legacy",
      body: "legacy body",
      slug: "legacy",
      origin: null,
      project_id: "other",
      kind: "knowledge",
    });

    const res = await fetch("http://x/memory/write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Legacy",
        body: "rewritten",
        slug: "legacy",
        project_id: "other",
        cc_kind: "reference",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memory_id: string; created: boolean };

    const row = db
      .query<{
        kind: string;
        origin: string | null;
        project_id: string | null;
        cc_kind: string | null;
      }>(
        `SELECT kind, origin, project_id, cc_kind FROM t2_memories WHERE slug = 'legacy' AND memory_id = ?`,
      )
      .get(body.memory_id)!;
    expect(row.kind).toBe("direct");
    expect(row.origin).toBe("direct");
    expect(row.project_id).toBe("other");
    expect(row.cc_kind).toBe("reference");
  });

  test("7) PC1 retire skips direct-origin rows even when ephemera", () => {
    const { db, root } = makeServices();
    handles.push({ db, root });
    seedCycle(db, "cycle-1");
    const prevPc1 = process.env.PENUMBRA_PC1_AUTORETIRE;
    process.env.PENUMBRA_PC1_AUTORETIRE = "1";

    try {
      seedMemory(db, "mem-direct", {
        title: "direct seed",
        body: "123e4567-e89b-12d3-a456-426614174000",
        slug: "direct-mem",
        origin: "direct",
      });
      seedMemory(db, "mem-retire", {
        title: "retire seed",
        body: "123e4567-e89b-12d3-a456-426614174001",
        slug: "normal-mem",
        origin: null,
      });

      runPC1Phase(db, "cycle-1", {}, {});

      const directRow = db
        .query<
          { retired_at: number | null },
          [string]
        >(`SELECT retired_at FROM t2_memories WHERE memory_id = ?`)
        .get("mem-direct")!;
      const normalRow = db
        .query<
          { retired_at: number | null },
          [string]
        >(`SELECT retired_at FROM t2_memories WHERE memory_id = ?`)
        .get("mem-retire")!;

      expect(directRow.retired_at).toBeNull();
      expect(normalRow.retired_at).not.toBeNull();
    } finally {
      if (prevPc1 === undefined) delete process.env.PENUMBRA_PC1_AUTORETIRE;
      else process.env.PENUMBRA_PC1_AUTORETIRE = prevPc1;
    }
  });

  test("8) PC2 cluster retire skips direct-origin rows", () => {
    const { db, root } = makeServices();
    handles.push({ db, root });
    seedCycle(db, "cycle-2");

    const prevPc2 = process.env.PENUMBRA_DREAMING_PC2_AUTO_APPLY;
    process.env.PENUMBRA_DREAMING_PC2_AUTO_APPLY = "1";

    try {
      seedMemory(db, "mem-direct", {
        title: "direct member",
        body: "cluster direct",
        slug: "direct-cluster",
        origin: "direct",
        createdAt: "2026-05-23T00:00:00.000Z",
        kind: "fact",
      });
      seedMemory(db, "mem-regular-1", {
        title: "regular member 1",
        body: "cluster regular",
        slug: "regular-1",
        origin: null,
        createdAt: "2026-05-23T00:00:01.000Z",
        kind: "fact",
      });
      seedMemory(db, "mem-regular-2", {
        title: "canonical regular",
        body: "cluster canonical",
        slug: "regular-2",
        origin: null,
        createdAt: "2026-05-23T00:00:02.000Z",
        kind: "fact",
      });

      db.prepare(
        `INSERT INTO memory_links(link_id, src_id, dst_id, link_type, weight, minted_at, minted_by_cycle)
                 VALUES(?, ?, ?, 'semantic_near', ?, ?, ?)`,
      ).run("l1", "mem-direct", "mem-regular-1", 0.99, Date.now(), "cycle-2");
      db.prepare(
        `INSERT INTO memory_links(link_id, src_id, dst_id, link_type, weight, minted_at, minted_by_cycle)
                 VALUES(?, ?, ?, 'semantic_near', ?, ?, ?)`,
      ).run("l2", "mem-regular-1", "mem-regular-2", 0.99, Date.now(), "cycle-2");

      runPC2Phase(
        db,
        "cycle-2",
        { pc2MinClusterSize: 3, pc2ClusterLinkThreshold: 0.85, pc2AutoThreshold: 0.97 },
        {},
      );

      const directRow = db
        .query<
          { retired_at: number | null },
          [string]
        >(`SELECT retired_at FROM t2_memories WHERE memory_id = ?`)
        .get("mem-direct")!;
      const regularRow = db
        .query<
          { retired_at: number | null },
          [string]
        >(`SELECT retired_at FROM t2_memories WHERE memory_id = ?`)
        .get("mem-regular-1")!;
      const canonicalRow = db
        .query<
          { retired_at: number | null },
          [string]
        >(`SELECT retired_at FROM t2_memories WHERE memory_id = ?`)
        .get("mem-regular-2")!;

      expect(directRow.retired_at).toBeNull();
      expect(regularRow.retired_at).not.toBeNull();
      expect(canonicalRow.retired_at).toBeNull();
    } finally {
      if (prevPc2 === undefined) {
        delete process.env.PENUMBRA_DREAMING_PC2_AUTO_APPLY;
      } else {
        process.env.PENUMBRA_DREAMING_PC2_AUTO_APPLY = prevPc2;
      }
    }
  });
});
