import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDaemonFetchHandler } from "../../src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

const SHARED_TOKEN = "shared-token";
const fixturesDir = join(import.meta.dir, "../fixtures/claude");

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
    fetch: (input, init) => handler(input instanceof Request ? input : new Request(input, init)),
  };
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
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
  const handles: { db: Database; root: string }[] = [];

  afterEach(() => {
    for (const handle of handles) {
      try {
        handle.db.close();
      } catch {
        // The in-memory database may already be closed if setup failed.
      }
      try {
        rmSync(handle.root, { recursive: true, force: true });
      } catch {
        // Temp cleanup is best-effort for failed route tests.
      }
    }
    handles.length = 0;
  });

  test("returns filtered session memory candidates with update slug information", async () => {
    const daemon = makeDaemon();
    handles.push({ db: daemon.db, root: daemon.root });
    process.env.PENUMBRA_CONFIG_DIR = writeAgentchatConfigWithoutJudge(daemon.root);
    seedT0(daemon.db, "session-extract-route");
    seedExistingT2(daemon.db);

    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(
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
        ),
      );

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
      candidates: {
        body: string;
        update_existing_slug?: string;
        existing_memory_id?: string;
      }[];
    };

    expect(payload.candidates.length).toBeGreaterThanOrEqual(1);
    expect(payload.candidates.some((candidate) => candidate.body.length < 80)).toBe(false);
    expect(
      payload.candidates.some(
        (candidate) =>
          candidate.update_existing_slug === "session-extract-existing-rule" &&
          candidate.existing_memory_id === "m-existing-route",
      ),
    ).toBe(true);
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
    globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
      judgeRequests.push(requestUrl(input));
      return Promise.resolve(
        new Response(
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
        ),
      );
    };

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
    const payload = (await res.json()) as { candidates: { title: string }[] };
    expect(
      payload.candidates.some((candidate) => candidate.title === "Agentchat Judge Route"),
    ).toBe(true);
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

  test("returns structured judge_failed JSON when the configured judge rejects", async () => {
    const daemon = makeDaemon();
    handles.push({ db: daemon.db, root: daemon.root });
    process.env.PENUMBRA_CONFIG_DIR = writeAgentchatConfigWithoutJudge(daemon.root);
    seedT0(daemon.db, "session-extract-judge-fails");

    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(
        new Response("backend offline", {
          status: 500,
          headers: { "content-type": "text/plain" },
        }),
      );

    const res = await daemon.fetch("http://x/memory/session-extract", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: "session-extract-judge-fails",
        project_id: "proj",
      }),
    });

    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
    const payload = (await res.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("judge_failed");
    expect(payload.error.message).toContain("Sirius returned 500: backend offline");
  });

  test("uses transcript_path to build judge transcript from assistant text blocks", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "session-memory-extract-config-"));
    process.env.PENUMBRA_CONFIG_DIR = writeAgentchatConfigWithoutJudge(configRoot);
    process.env.PENUMBRA_SIRIUS_BASE_URL = "http://judge.local";
    delete process.env.SIRIUS_URL;
    const daemon = makeDaemon();
    handles.push({ db: daemon.db, root: daemon.root });
    seedT0(daemon.db, "session-extract-transcript");
    const toolTranscript =
      "Implementation artifact summary from tool output that should not be used when transcript_path is present. ".repeat(
        6,
      );
    daemon.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
       VALUES (?, ?, ?, 'mcp', 'u1', 'm1', 'session-extract-transcript', 'agent-response', 'local', '{}', ?)`,
      [
        "e-session-extract-3",
        "2026-06-11T10:02:00.000Z",
        "2026-06-11T10:02:00.000Z",
        toolTranscript,
      ],
    );

    let judgePrompt = "";
    let fetchCalls = 0;
    globalThis.fetch = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      fetchCalls += 1;
      let bodyText = "";
      if (typeof init?.body === "string") {
        bodyText = init.body;
      } else if (_input instanceof Request && !_input.bodyUsed) {
        try {
          bodyText = await _input.text();
        } catch {
          bodyText = "";
        }
      }
      if (bodyText) {
        judgePrompt = bodyText;
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  memories: [
                    {
                      title: "Session Transcript Candidate",
                      body: "This durable fact was extracted from assistant prose in the transcript.",
                      kind: "decision",
                      why: "Unique-suffix sink stability is useful across sessions.",
                      source_quote: "unique-suffix sink is verified live",
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
    };

    const res = await daemon.fetch("http://x/memory/session-extract", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: "session-extract-transcript",
        project_id: "proj",
        transcript_path: join(fixturesDir, "session-memory-extract-prose.jsonl"),
      }),
    });

    expect(res.status).toBe(200);
    expect(fetchCalls).toBe(1);
    expect(judgePrompt).toContain("daemon bounced to pid 80048");
    expect(judgePrompt).toContain("unique-suffix sink is verified live");
    expect(judgePrompt).not.toContain(toolTranscript.slice(0, 24));

    const payload = (await res.json()) as {
      candidates: { title: string; body: string; why: string }[];
    };
    expect(
      payload.candidates.some((candidate) => candidate.title === "Session Transcript Candidate"),
    ).toBe(true);
  });

  test("strips private spans from transcript_path before calling the judge", async () => {
    const daemon = makeDaemon();
    handles.push({ db: daemon.db, root: daemon.root });
    process.env.PENUMBRA_CONFIG_DIR = writeAgentchatConfigWithoutJudge(daemon.root);

    const transcriptPath = join(daemon.root, "private-transcript.jsonl");
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content:
            "The durable public memory extraction rule should keep only public transcript text that is safe for external judging. ".repeat(
              3,
            ) + "<private>my SSN is 123-45-6789</private>",
        },
      }) + "\n",
    );

    let judgePrompt = "";
    globalThis.fetch = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (typeof init?.body === "string") {
        judgePrompt = init.body;
      } else if (_input instanceof Request && !_input.bodyUsed) {
        judgePrompt = await _input.text();
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  memories: [
                    {
                      title: "Private Transcript Redaction",
                      body: "Session extraction must avoid forwarding private-tagged transcript content to the external memory judge.",
                      kind: "decision",
                      why: "Private spans are user-marked sensitive data and must not leave the process.",
                      source_quote: "only public transcript text",
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
    };

    const res = await daemon.fetch("http://x/memory/session-extract", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: "session-extract-private-transcript",
        project_id: "proj",
        transcript_path: transcriptPath,
      }),
    });

    expect(res.status).toBe(200);
    expect(judgePrompt).toContain("only public transcript text");
    expect(judgePrompt).not.toContain("123-45-6789");
  });

  test("strips private spans from payload_json when payload_summary is null", async () => {
    const daemon = makeDaemon();
    handles.push({ db: daemon.db, root: daemon.root });
    process.env.PENUMBRA_CONFIG_DIR = writeAgentchatConfigWithoutJudge(daemon.root);
    daemon.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
       VALUES (?, ?, ?, 'mcp', 'u1', 'm1', 'session-extract-private-payload', 'agent-prompt', 'local', ?, NULL)`,
      [
        "e-session-extract-private-payload",
        "2026-06-11T10:04:00.000Z",
        "2026-06-11T10:04:00.000Z",
        JSON.stringify({
          prompt:
            "The durable public payload rule should preserve safe text from normalized event payloads for the external judge. ".repeat(
              3,
            ) + "<private>my SSN is 123-45-6789</private>",
        }),
      ],
    );

    let judgePrompt = "";
    globalThis.fetch = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (typeof init?.body === "string") {
        judgePrompt = init.body;
      } else if (_input instanceof Request && !_input.bodyUsed) {
        judgePrompt = await _input.text();
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  memories: [
                    {
                      title: "Private Payload Redaction",
                      body: "Session extraction must avoid forwarding private-tagged payload JSON content to the external memory judge.",
                      kind: "decision",
                      why: "Payload JSON can bypass ingest normalization on this route and still needs redaction.",
                      source_quote: "safe text from normalized event payloads",
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
    };

    const res = await daemon.fetch("http://x/memory/session-extract", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: "session-extract-private-payload",
        project_id: "proj",
      }),
    });

    expect(res.status).toBe(200);
    expect(judgePrompt).toContain("safe text from normalized event payloads");
    expect(judgePrompt).not.toContain("123-45-6789");
  });

  test("returns zero candidates for transcript_path with no durable assistant prose", async () => {
    const daemon = makeDaemon();
    handles.push({ db: daemon.db, root: daemon.root });
    const toolTranscript =
      "Implementation artifact summary for tool-heavy execution that should not produce durable memory. ".repeat(
        8,
      );
    daemon.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
       VALUES (?, ?, ?, 'mcp', 'u1', 'm1', 'session-extract-trivial', 'agent-response', 'local', '{}', ?)`,
      [
        "e-session-extract-4",
        "2026-06-11T10:03:00.000Z",
        "2026-06-11T10:03:00.000Z",
        toolTranscript,
      ],
    );

    let judgeCalled = false;
    globalThis.fetch = (): Promise<Response> => {
      judgeCalled = true;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    memories: [
                      { title: "unused", body: "n/a", kind: "fact", why: "skip", depth: 2 },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };

    const res = await daemon.fetch("http://x/memory/session-extract", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SHARED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: "session-extract-trivial",
        project_id: "proj",
        transcript_path: join(fixturesDir, "session-memory-extract-trivial.jsonl"),
      }),
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { candidates: { title: string }[] };
    expect(payload.candidates).toEqual([]);
    expect(judgeCalled).toBe(false);
  });
});
