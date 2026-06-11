import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { createDaemonFetchHandler } from "../../src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

const SHARED_TOKEN = "shared-token";

let previousJudgeUrl: string | undefined;
let previousSiriusUrl: string | undefined;
let previousConfigDir: string | undefined;
let previousFetch: typeof globalThis.fetch;

beforeEach(() => {
  previousJudgeUrl = process.env.PENUMBRA_SIRIUS_BASE_URL;
  previousSiriusUrl = process.env.SIRIUS_URL;
  previousConfigDir = process.env.PENUMBRA_CONFIG_DIR;
  previousFetch = globalThis.fetch;
  process.env.PENUMBRA_SIRIUS_BASE_URL = "http://judge.local";
  delete process.env.SIRIUS_URL;
  delete process.env.PENUMBRA_CONFIG_DIR;
});

afterEach(() => {
  if (previousJudgeUrl === undefined) delete process.env.PENUMBRA_SIRIUS_BASE_URL;
  else process.env.PENUMBRA_SIRIUS_BASE_URL = previousJudgeUrl;
  if (previousSiriusUrl === undefined) delete process.env.SIRIUS_URL;
  else process.env.SIRIUS_URL = previousSiriusUrl;
  if (previousConfigDir === undefined) delete process.env.PENUMBRA_CONFIG_DIR;
  else process.env.PENUMBRA_CONFIG_DIR = previousConfigDir;
  globalThis.fetch = previousFetch;
});

function makeDaemon(): {
  services: Services;
  db: Database;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  root: string;
} {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const root = mkdtempSync(join(tmpdir(), "memory-session-extract-test-"));
  mkdirSync(join(root, "worktrees"), { recursive: true });
  mkdirSync(join(root, ".penumbra", "reviews"), { recursive: true });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: join(root, "storage"),
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });

  const handler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  return {
    services,
    db,
    root,
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      handler(new Request(input as string, init))) as (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>,
  };
}

function seedT0(db: Database, sessionId: string): void {
  const prompt =
    "User asked to add session extract candidate generation for durable memory updates with TDD and focused verification.";
  const response =
    "Assistant implemented the route so future sessions can preview candidate updates before writing direct memories.";
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
     VALUES (?, ?, ?, 'mcp', 'u1', 'm1', ?, 'agent-prompt', 'local', '{}', ?)`,
    [
      "e-session-extract-1",
      "2026-06-11T10:00:00.000Z",
      "2026-06-11T10:00:00.000Z",
      sessionId,
      prompt,
    ],
  );
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
     VALUES (?, ?, ?, 'mcp', 'u1', 'm1', ?, 'agent-response', 'local', '{}', ?)`,
    [
      "e-session-extract-2",
      "2026-06-11T10:01:00.000Z",
      "2026-06-11T10:01:00.000Z",
      sessionId,
      response,
    ],
  );
}

function seedExistingT2(db: Database): void {
  const now = "2026-06-11T09:00:00.000Z";
  db.run(
    `INSERT INTO t2_memories(
      memory_id, project_id, user_id, kind, source_session_ids,
      window_start, window_end, title, body, metadata_json,
      compressed_from, created_at, updated_at, slug, why, depth
    ) VALUES('m-existing-route', 'proj', 'u1', 'fact', '[]', ?, ?, ?, ?, '{}', NULL, ?, ?, ?, ?, ?)`,
    [
      now,
      now,
      "Session Extract Existing Rule",
      "Older direct-memory body for the same session extract rule.",
      now,
      now,
      "session-extract-existing-rule",
      "Existing route memory should be updated rather than duplicated.",
      2,
    ],
  );
  const rowid = db
    .query<{ rowid: number }, [string]>("SELECT rowid FROM t2_memories WHERE memory_id = ?")
    .get("m-existing-route")!.rowid;
  db.run("INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)", [rowid, new Float32Array(384)]);
}

function writeAgentchatJudgeConfig(root: string, baseUrl: string): string {
  const dir = join(root, "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agents.yaml"),
    [
      "agents:",
      "  - name: route-memory-refiner",
      "    adapter: openai-compat-http",
      "    options:",
      `      baseUrl: ${baseUrl}`,
      "      model: granite",
      "    roles: [memory-refiner]",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "routing.yaml"), "default_roles: {}\n");
  writeFileSync(join(dir, "quotas.yaml"), "providers: []\n");
  return dir;
}

function writeAgentchatConfigWithoutJudge(root: string): string {
  const dir = join(root, "config-no-judge");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agents.yaml"),
    [
      "agents:",
      "  - name: planner",
      "    adapter: openai-compat-http",
      "    options:",
      "      baseUrl: http://planner/v1",
      "      model: granite",
      "    roles: [planner]",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "routing.yaml"), "default_roles: {}\n");
  writeFileSync(join(dir, "quotas.yaml"), "providers: []\n");
  return dir;
}

describe("POST /memory/session-extract", () => {
  const handles: Array<{ db: Database; root: string }> = [];

  afterEach(() => {
    for (const handle of handles) {
      try {
        handle.db.close();
      } catch {}
      try {
        rmSync(handle.root, { recursive: true, force: true });
      } catch {}
    }
    handles.length = 0;
  });

  test("returns filtered session memory candidates with update slug information", async () => {
    const daemon = makeDaemon();
    handles.push({ db: daemon.db, root: daemon.root });
    process.env.PENUMBRA_CONFIG_DIR = writeAgentchatConfigWithoutJudge(daemon.root);
    seedT0(daemon.db, "session-extract-route");
    seedExistingT2(daemon.db);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  memories: [
                    {
                      title: "Session Extract Existing Rule",
                      body: "Session extract should update existing slug rows because preview candidates must not duplicate direct memories.",
                      kind: "decision",
                      why: "The route has to surface update intent when a title maps onto an existing durable memory slug.",
                      source_quote: "update existing slug rows",
                      depth: 2,
                    },
                    {
                      title: "Tiny Candidate",
                      body: "Too short.",
                      kind: "fact",
                      why: "This why is long enough but the body is shallow and should still be filtered.",
                      depth: 1,
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof globalThis.fetch;

    const res = await daemon.fetch("http://x/memory/session-extract", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: "session-extract-route",
        project_id: "proj",
        max_candidates: 10,
      }),
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      candidates: Array<{
        body: string;
        update_existing_slug?: string;
        existing_memory_id?: string;
      }>;
    };

    expect(payload.candidates.length).toBeGreaterThanOrEqual(1);
    expect(payload.candidates.some((candidate) => candidate.body.length < 80)).toBe(false);
    expect(payload.candidates).toContainEqual(
      expect.objectContaining({
        update_existing_slug: "session-extract-existing-rule",
        existing_memory_id: "m-existing-route",
      }),
    );
  });

  test("uses an agentchat memory-refiner judge when sirius env is unset", async () => {
    const daemon = makeDaemon();
    handles.push({ db: daemon.db, root: daemon.root });
    seedT0(daemon.db, "session-extract-agentchat");
    delete process.env.PENUMBRA_SIRIUS_BASE_URL;
    delete process.env.SIRIUS_URL;
    process.env.PENUMBRA_CONFIG_DIR = writeAgentchatJudgeConfig(
      daemon.root,
      "http://agentchat-judge/v1",
    );

    const judgeRequests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      judgeRequests.push(String(input));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  memories: [
                    {
                      title: "Agentchat Judge Route",
                      body: "Session extraction should use the agentchat memory-refiner pool when Sirius environment variables are absent.",
                      kind: "decision",
                      why: "Production memory-refiner agents can serve extraction without requiring the legacy Sirius env path.",
                      source_quote: "agentchat memory-refiner pool",
                      depth: 2,
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    const res = await daemon.fetch("http://x/memory/session-extract", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: "session-extract-agentchat",
        project_id: "proj",
      }),
    });

    expect(res.status).toBe(200);
    expect(judgeRequests).toEqual(["http://agentchat-judge/v1/chat/completions"]);
    const payload = (await res.json()) as { candidates: Array<{ title: string }> };
    expect(payload.candidates).toContainEqual(
      expect.objectContaining({ title: "Agentchat Judge Route" }),
    );
  });

  test("returns judge_unconfigured when no sirius env or agentchat judge is available", async () => {
    const daemon = makeDaemon();
    handles.push({ db: daemon.db, root: daemon.root });
    seedT0(daemon.db, "session-extract-unconfigured");
    delete process.env.PENUMBRA_SIRIUS_BASE_URL;
    delete process.env.SIRIUS_URL;
    process.env.PENUMBRA_CONFIG_DIR = writeAgentchatConfigWithoutJudge(daemon.root);

    const res = await daemon.fetch("http://x/memory/session-extract", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: "session-extract-unconfigured",
        project_id: "proj",
      }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: {
        code: "judge_unconfigured",
        message: "memory session extraction requires a configured LLM judge",
      },
    });
  });
});
