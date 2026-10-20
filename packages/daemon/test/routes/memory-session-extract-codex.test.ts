import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memorySessionExtractRoute } from "@src/routes/memory-session-extract.js";

const FORMAT = "penumbra-codex-rollout-fixture-v1";

type Fixture = {
  services: Services;
  db: Database;
  root: string;
  sessions: string;
  cwd: string;
};

const fixtures: Fixture[] = [];
let priorJudgeUrl: string | undefined;
let priorConfigDir: string | undefined;
let priorFetch: typeof globalThis.fetch;

beforeEach(() => {
  priorJudgeUrl = process.env.PENUMBRA_JUDGE_BASE_URL;
  priorConfigDir = process.env.PENUMBRA_CONFIG_DIR;
  priorFetch = globalThis.fetch;
  process.env.PENUMBRA_JUDGE_BASE_URL = "http://judge.local";
});

afterEach(async () => {
  if (priorJudgeUrl === undefined) delete process.env.PENUMBRA_JUDGE_BASE_URL;
  else process.env.PENUMBRA_JUDGE_BASE_URL = priorJudgeUrl;
  if (priorConfigDir === undefined) delete process.env.PENUMBRA_CONFIG_DIR;
  else process.env.PENUMBRA_CONFIG_DIR = priorConfigDir;
  globalThis.fetch = priorFetch;
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function makeFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "memory-session-extract-codex-")));
  const sessions = join(root, "codex-home", "sessions");
  const cwd = join(root, "project");
  await mkdir(sessions, { recursive: true });
  await mkdir(cwd);
  const config = join(root, "config");
  await mkdir(config);
  await writeFile(
    join(config, "agents.yaml"),
    [
      "agents:",
      "  - name: planner",
      "    adapter: openai-compat-http",
      "    api_provider: local",
      "    options:",
      "      baseUrl: http://planner.invalid/v1",
      "      model: test",
      "    roles: [planner]",
      "",
    ].join("\n"),
  );
  await writeFile(join(config, "routing.yaml"), "default_roles: {}\n");
  await writeFile(join(config, "quotas.yaml"), "providers: []\n");
  process.env.PENUMBRA_CONFIG_DIR = config;
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: join(root, "storage"),
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });
  const fixture = {
    services,
    db,
    root,
    sessions: await realpath(sessions),
    cwd: await realpath(cwd),
  };
  fixtures.push(fixture);
  return fixture;
}

function seedSessionEvidence(
  fixture: Fixture,
  sessionId = "session-a",
  projectId = "project-a",
  cwd = fixture.cwd,
): void {
  fixture.services.sessionEventLog.record({
    session_id: sessionId,
    project_id: projectId,
    cwd,
    transcript_path: null,
    kind: "session.pre_compact",
    ts: "2026-09-12T10:00:00.000Z",
    meta: {
      ingress: {
        harness: "codex",
        role: "maestro",
        lineage: "root",
        provenance: "verified-session-correlation",
        is_child: false,
        parent_session_id: null,
        transcript_format: FORMAT,
      },
    },
  });
}

function seedT0(opts: {
  fixture: Fixture;
  id: string;
  sessionId: string;
  projectId: string;
  source: "codex" | "claude-code";
  eventType: "agent-prompt" | "agent-response";
  summary?: string | null;
  payload?: Record<string, unknown>;
}): void {
  opts.fixture.db.run(
    `INSERT INTO t0_events(
      event_id, ts, ingest_ts, source, project_id, user_id, machine_id, session_id,
      event_type, lane, payload_json, payload_summary
    ) VALUES (?, ?, ?, ?, ?, 'u1', 'm1', ?, ?, 'cli-subscription', ?, ?)`,
    [
      opts.id,
      `2026-09-12T10:00:${opts.id.slice(-2).padStart(2, "0")}.000Z`,
      "2026-09-12T10:00:00.000Z",
      opts.source,
      opts.projectId,
      opts.sessionId,
      opts.eventType,
      JSON.stringify(opts.payload ?? {}),
      opts.summary ?? null,
    ],
  );
}

function transcript(
  cwd: string,
  sessionId: string,
  userText: string,
  assistantText: string,
): string {
  return (
    [
      {
        type: "session_meta",
        payload: {
          id: sessionId,
          session_id: sessionId,
          cwd,
          originator: "codex_exec",
          cli_version: "0.153.4",
          source: "exec",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: assistantText }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n"
  );
}

function request(body: Record<string, unknown>): Request {
  return new Request("http://x/memory/session-extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function invoke(fixture: Fixture, body: Record<string, unknown>): Promise<Response> {
  return await memorySessionExtractRoute(request(body), fixture.services, {
    codexSessionsRoot: fixture.sessions,
  });
}

function installJudgeCapture(): { prompts: string[] } {
  const prompts: string[] = [];
  const fetchMock = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (typeof init?.body === "string") prompts.push(init.body);
    else if (input instanceof Request) prompts.push(await input.clone().text());
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  globalThis.fetch = Object.assign(fetchMock, { preconnect: priorFetch.preconnect });
  return { prompts };
}

function codexBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    harness: "codex",
    transcript_format: FORMAT,
    session_id: "session-a",
    project_id: "project-a",
    ...overrides,
  };
}

describe("POST /memory/session-extract Codex", () => {
  test("prefers adequate normalized exact-scope Codex observations and strips private content", async () => {
    const fixture = await makeFixture();
    seedSessionEvidence(fixture);
    const publicPrompt = `TARGET_PUBLIC_PROMPT ${"p".repeat(120)}`;
    const publicResponse = `TARGET_PUBLIC_RESPONSE ${"r".repeat(120)}`;
    seedT0({
      fixture,
      id: "01",
      sessionId: "session-a",
      projectId: "project-a",
      source: "codex",
      eventType: "agent-prompt",
      summary: `${publicPrompt}<private>TARGET_PRIVATE_SENTINEL</private>`,
    });
    seedT0({
      fixture,
      id: "02",
      sessionId: "session-a",
      projectId: "project-a",
      source: "codex",
      eventType: "agent-response",
      payload: { response: `${publicResponse}<private>PAYLOAD_PRIVATE_SENTINEL</private>` },
    });
    for (const [id, sessionId, projectId, source, sentinel] of [
      ["03", "session-a", "project-b", "codex", "FOREIGN_PROJECT_SENTINEL"],
      ["04", "session-b", "project-a", "codex", "FOREIGN_SESSION_SENTINEL"],
      ["05", "session-a", "project-a", "claude-code", "FOREIGN_SOURCE_SENTINEL"],
    ] as const) {
      seedT0({
        fixture,
        id,
        sessionId,
        projectId,
        source,
        eventType: "agent-response",
        summary: sentinel.repeat(20),
      });
    }
    const judge = installJudgeCapture();

    const response = await invoke(fixture, codexBody());

    expect(response.status).toBe(200);
    expect(judge.prompts).toHaveLength(1);
    expect(judge.prompts[0]).toContain(publicPrompt);
    expect(judge.prompts[0]).toContain(publicResponse);
    expect(judge.prompts[0]).not.toMatch(
      /TARGET_PRIVATE_SENTINEL|PAYLOAD_PRIVATE_SENTINEL|FOREIGN_PROJECT_SENTINEL|FOREIGN_SESSION_SENTINEL|FOREIGN_SOURCE_SENTINEL/,
    );
  });

  test("falls back to the exact guarded Codex path when normalized observations are insufficient", async () => {
    const fixture = await makeFixture();
    seedSessionEvidence(fixture);
    seedT0({
      fixture,
      id: "01",
      sessionId: "session-a",
      projectId: "project-a",
      source: "codex",
      eventType: "agent-prompt",
      summary: "too short and only one role",
    });
    const path = join(fixture.sessions, "session-a.jsonl");
    await writeFile(
      path,
      transcript(
        fixture.cwd,
        "session-a",
        `FILE_USER_TEXT ${"u".repeat(120)}`,
        `FILE_ASSISTANT_TEXT ${"a".repeat(120)}`,
      ),
    );
    const judge = installJudgeCapture();

    const response = await invoke(fixture, codexBody({ transcript_path: path }));

    expect(response.status).toBe(200);
    expect(judge.prompts).toHaveLength(1);
    expect(judge.prompts[0]).toContain("FILE_USER_TEXT");
    expect(judge.prompts[0]).toContain("FILE_ASSISTANT_TEXT");
    expect(judge.prompts[0]).not.toContain("too short and only one role");
  });

  test("rejects unsupported formats, outside paths, wrong headers, and request cwd without a judge call", async () => {
    const fixture = await makeFixture();
    seedSessionEvidence(fixture);
    const outside = join(fixture.root, "outside.jsonl");
    const wrongSession = join(fixture.sessions, "wrong-session.jsonl");
    const otherCwd = join(fixture.root, "other-project");
    const wrongCwd = join(fixture.sessions, "wrong-cwd.jsonl");
    await mkdir(otherCwd);
    await writeFile(
      outside,
      transcript(fixture.cwd, "session-a", "OUTSIDE_USER", "OUTSIDE_ASSISTANT"),
    );
    await writeFile(
      wrongSession,
      transcript(fixture.cwd, "session-b", "WRONG_SESSION_USER", "WRONG_SESSION_ASSISTANT"),
    );
    await writeFile(
      wrongCwd,
      transcript(otherCwd, "session-a", "WRONG_CWD_USER", "WRONG_CWD_ASSISTANT"),
    );
    const judge = installJudgeCapture();

    const unsupported = await invoke(
      fixture,
      codexBody({ transcript_format: "self-claimed-codex-jsonl", transcript_path: wrongSession }),
    );
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toMatchObject({ error: { code: "unsupported_transcript" } });

    const escaped = await invoke(fixture, codexBody({ transcript_path: outside }));
    expect(escaped.status).toBe(403);
    expect(await escaped.json()).toMatchObject({
      error: { code: "transcript_scope_violation" },
    });

    for (const path of [wrongSession, wrongCwd]) {
      const mismatch = await invoke(fixture, codexBody({ transcript_path: path }));
      expect(mismatch.status).toBe(422);
      expect(await mismatch.json()).toMatchObject({
        error: { code: "transcript_identity_mismatch" },
      });
    }

    const requestCwd = await invoke(fixture, codexBody({ cwd: fixture.cwd }));
    expect(requestCwd.status).toBe(400);
    expect(judge.prompts).toHaveLength(0);
  });

  test("requires current matching daemon session evidence before transcript access", async () => {
    const fixture = await makeFixture();
    seedSessionEvidence(fixture, "session-a", "project-a");
    seedSessionEvidence(fixture, "session-a", "project-b");
    const path = join(fixture.sessions, "session-a.jsonl");
    await writeFile(
      path,
      transcript(
        fixture.cwd,
        "session-a",
        `UNAUTHORIZED_USER ${"u".repeat(120)}`,
        `UNAUTHORIZED_ASSISTANT ${"a".repeat(120)}`,
      ),
    );
    const judge = installJudgeCapture();

    const response = await invoke(fixture, codexBody({ transcript_path: path }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "transcript_scope_violation" },
    });
    expect(judge.prompts).toHaveLength(0);
  });

  test("does not bypass newer unsupported Codex evidence with an older qualified event", async () => {
    const fixture = await makeFixture();
    seedSessionEvidence(fixture);
    fixture.services.sessionEventLog.record({
      session_id: "session-a",
      project_id: "project-a",
      cwd: fixture.cwd,
      kind: "session.pre_compact",
      ts: "2026-09-12T10:01:00.000Z",
      meta: {
        ingress: {
          harness: "codex",
          role: "maestro",
          lineage: "root",
          provenance: "verified-session-correlation",
          is_child: false,
          parent_session_id: null,
          transcript_format: "self-claimed-codex-jsonl",
        },
      },
    });
    seedT0({
      fixture,
      id: "01",
      sessionId: "session-a",
      projectId: "project-a",
      source: "codex",
      eventType: "agent-prompt",
      summary: `UNTRUSTED_USER ${"u".repeat(120)}`,
    });
    seedT0({
      fixture,
      id: "02",
      sessionId: "session-a",
      projectId: "project-a",
      source: "codex",
      eventType: "agent-response",
      summary: `UNTRUSTED_ASSISTANT ${"a".repeat(120)}`,
    });
    const judge = installJudgeCapture();

    const response = await invoke(fixture, codexBody());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "unsupported_transcript" },
    });
    expect(judge.prompts).toHaveLength(0);
  });

  test("does not treat malformed root ingress metadata as verified session evidence", async () => {
    const fixture = await makeFixture();
    fixture.services.sessionEventLog.record({
      session_id: "session-a",
      project_id: "project-a",
      cwd: fixture.cwd,
      kind: "session.pre_compact",
      ts: "2026-09-12T10:00:00.000Z",
      meta: {
        ingress: {
          harness: "codex",
          role: "maestro",
          lineage: "root",
          is_child: false,
          parent_session_id: null,
          transcript_format: FORMAT,
        },
      },
    });
    const path = join(fixture.sessions, "session-a.jsonl");
    await writeFile(
      path,
      transcript(
        fixture.cwd,
        "session-a",
        `MALFORMED_USER ${"u".repeat(120)}`,
        `MALFORMED_ASSISTANT ${"a".repeat(120)}`,
      ),
    );
    const judge = installJudgeCapture();

    const response = await invoke(fixture, codexBody({ transcript_path: path }));

    expect(response.status).toBe(403);
    expect(judge.prompts).toHaveLength(0);
  });

  test("requires explicit project authority and rejects request-supplied root lists", async () => {
    const fixture = await makeFixture();
    const judge = installJudgeCapture();

    const missingProject = await invoke(fixture, codexBody({ project_id: null }));
    expect(missingProject.status).toBe(400);
    expect(await missingProject.json()).toMatchObject({ error: { code: "validation_error" } });

    const suppliedRoots = await invoke(fixture, codexBody({ allowed_roots: [fixture.sessions] }));
    expect(suppliedRoots.status).toBe(400);
    expect(judge.prompts).toHaveLength(0);
  });

  test("returns deliberate insufficient data for unavailable or one-role inputs", async () => {
    const fixture = await makeFixture();
    seedSessionEvidence(fixture);
    seedT0({
      fixture,
      id: "01",
      sessionId: "session-a",
      projectId: "project-a",
      source: "codex",
      eventType: "agent-prompt",
      summary: "one role only ".repeat(30),
    });
    const judge = installJudgeCapture();

    for (const transcriptPath of [undefined, join(fixture.sessions, "missing.jsonl")]) {
      const response = await invoke(
        fixture,
        codexBody({ ...(transcriptPath ? { transcript_path: transcriptPath } : {}) }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        candidates: [],
        insufficient_data: true,
        chunks_judged: 0,
      });
    }
    expect(judge.prompts).toHaveLength(0);
  });

  test("resolves the judge only after a safe adequate Codex transcript is selected", async () => {
    const fixture = await makeFixture();
    seedSessionEvidence(fixture);
    seedT0({
      fixture,
      id: "01",
      sessionId: "session-a",
      projectId: "project-a",
      source: "codex",
      eventType: "agent-prompt",
      summary: `SAFE_USER ${"u".repeat(120)}`,
    });
    seedT0({
      fixture,
      id: "02",
      sessionId: "session-a",
      projectId: "project-a",
      source: "codex",
      eventType: "agent-response",
      summary: `SAFE_ASSISTANT ${"a".repeat(120)}`,
    });
    delete process.env.PENUMBRA_JUDGE_BASE_URL;

    const response = await invoke(fixture, codexBody());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "judge_unconfigured",
        message: "memory session extraction requires a configured LLM judge",
      },
    });
  });
});
