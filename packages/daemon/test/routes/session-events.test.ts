import { SessionEventsListResponseSchema } from "@penumbra/api-contract";
import {
  buildServices,
  loadSqliteVec,
  migrate,
  ProjectRegistry,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { buildRegistry } from "@penumbra/workflows";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDaemonFetchHandler } from "@src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

interface Harness {
  services: Services;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  stop(): void;
}

function startHarness(
  opts: {
    workflowRegistry?: Services["workflowRegistry"];
    projectRegistry?: Services["projectRegistry"];
  } = {},
): Harness {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const root = mkdtempSync(join(tmpdir(), "session-events-route-"));
  const token = "tok";
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-01T00:00:03.000Z"),
    workflowRegistry: opts.workflowRegistry,
    projectRegistry: opts.projectRegistry,
  });
  const handler = createDaemonFetchHandler({ services, token });
  return {
    services,
    fetch(path: string, init?: RequestInit): Promise<Response> {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return handler(new Request(`http://x${path}`, { ...init, headers }));
    },
    stop(): void {
      services.supervisor.stopAll();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function jsonHeaders(): Record<string, string> {
  return { "content-type": "application/json" };
}

function seedRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "boot-pickup-repo-"));
  execSync("git init -q -b main", { cwd: repo });
  execSync("git config user.email t@t", { cwd: repo });
  execSync("git config user.name t", { cwd: repo });
  execSync("git remote add origin https://example.test/penumbra.git", { cwd: repo });
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  execSync('git add tracked.txt && git commit -q -m "init"', { cwd: repo, shell: "/bin/bash" });
  return repo;
}

async function bootPickupHarness(
  names: string[] = ["maestro-context-prime"],
): Promise<{ harness: Harness; repo: string }> {
  const root = mkdtempSync(join(tmpdir(), "boot-pickup-playbooks-"));
  for (const name of names) {
    const playbookDir = join(root, `playbooks/${name}`);
    mkdirSync(playbookDir, { recursive: true });
    writeFileSync(
      join(playbookDir, "playbook.md"),
      `---\nname: ${name}\ndescription: boot pickup\ntriggers:\n  - kind: lifecycle\n    event: session-start\nrecall:\n  - source: latest_continuation_note\n    args: {}\n  - source: session_first_moves\n    args: {}\noutput:\n  - kind: session-reminder\nrun:\n  kind: markdown-template\n---\n{{recall.latest_continuation_note.body}}\n{{recall.session_first_moves.head_sha}}\n`,
    );
  }
  mkdirSync(join(root, "workflows"), { recursive: true });
  const repo = seedRepo();
  const harness = startHarness({
    projectRegistry: new ProjectRegistry(
      new Map([["penumbra", { project_id: "penumbra", root_path: repo }]]),
    ),
    workflowRegistry: await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    }),
  });
  const originalStop = harness.stop.bind(harness);
  harness.stop = (): void => {
    originalStop();
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  };
  return { harness, repo };
}

test("POST /session-events with an unknown kind returns 400", async () => {
  const h = startHarness();
  try {
    const res = await h.fetch("/session-events", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        events: [
          {
            session_id: "s-1",
            kind: "session.unknown",
            ts: "2026-05-01T00:00:00.000Z",
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
  } finally {
    h.stop();
  }
});

test("POST /session-events accepts string meta", async () => {
  const h = startHarness();
  try {
    const res = await h.fetch("/session-events", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        events: [
          {
            session_id: "s-string-meta",
            kind: "session.start",
            ts: "2026-05-01T00:00:00.000Z",
            meta: "plain meta",
          },
        ],
      }),
    });

    if (res.status !== 200) {
      throw new Error(`unexpected status ${String(res.status)}: ${await res.text()}`);
    }
    const get = await h.fetch("/session-events?session_id=s-string-meta");
    const body: unknown = await get.json();
    const parsed = SessionEventsListResponseSchema.parse(body);
    expect(parsed.events[0]?.meta).toBe("plain meta");
  } finally {
    h.stop();
  }
});

test("POST /session-events rejects oversized meta with 400 and no partial insert", async () => {
  const h = startHarness();
  try {
    const res = await h.fetch("/session-events", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        events: [
          {
            session_id: "s-huge-meta",
            kind: "session.start",
            ts: "2026-05-01T00:00:00.000Z",
            meta: { blob: "x".repeat(8190) },
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) throw new Error("expected error body");
    const errorBody = body as { error?: unknown; message?: unknown };
    expect(errorBody.error).toBe("meta_too_large");
    if (typeof errorBody.message !== "string") throw new Error("expected string error message");
    expect(errorBody.message).toContain("meta JSON must be <= 8192 bytes");
    const row = h.services.db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session_events")
      .get();
    expect(row?.count).toBe(0);
  } finally {
    h.stop();
  }
});

test("GET /session-events?kind_prefix=continuity. returns rows newest-first", async () => {
  const h = startHarness();
  try {
    h.services.db.run(`
      INSERT INTO session_events (session_id, kind, ts, meta_json)
      VALUES
        ('s-1', 'continuity.draft_composed', '2026-05-01T00:00:00.000Z', '{"n":1}'),
        ('s-1', 'session.start', '2026-05-01T00:00:01.000Z', NULL),
        ('s-2', 'continuity.boot_pickup', '2026-05-01T00:00:02.000Z', '{"n":2}');
    `);

    const res = await h.fetch("/session-events?kind_prefix=continuity.");
    if (res.status !== 200) {
      throw new Error(`unexpected status ${String(res.status)}: ${await res.text()}`);
    }
    const body: unknown = await res.json();
    const parsed = SessionEventsListResponseSchema.parse(body);
    expect(parsed.events.map((event) => event.kind)).toEqual([
      "continuity.boot_pickup",
      "continuity.draft_composed",
    ]);
    expect(parsed.events[0]?.meta).toEqual({ n: 2 });
  } finally {
    h.stop();
  }
});

test("POST /workflows/trigger with hook_event_name=SessionEnd persists one session.end row", async () => {
  const h = startHarness({
    workflowRegistry: {
      list: () => [],
      entries: () => [],
      get: () => undefined,
      getEntry: () => undefined,
      findByTrigger: () => [],
      errors: [],
    },
  });
  try {
    const res = await h.fetch("/workflows/trigger", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: { kind: "lifecycle", event: "session-end" },
        hook_event_name: "SessionEnd",
        cwd: process.cwd(),
        session_id: "s-end",
        transcript_path: "/tmp/transcript.jsonl",
      }),
    });
    if (res.status !== 200) {
      throw new Error(`unexpected status ${String(res.status)}: ${await res.text()}`);
    }

    const rows = h.services.db
      .query<
        { session_id: string; kind: string; transcript_path: string | null },
        []
      >("SELECT session_id, kind, transcript_path FROM session_events")
      .all();
    expect(rows).toEqual([
      { session_id: "s-end", kind: "session.end", transcript_path: "/tmp/transcript.jsonl" },
    ]);
  } finally {
    h.stop();
  }
});

test("trigger-ingested event without session_id stores NULL and GET /session-events validates", async () => {
  const h = startHarness({
    workflowRegistry: {
      list: () => [],
      entries: () => [],
      get: () => undefined,
      getEntry: () => undefined,
      findByTrigger: () => [],
      errors: [],
    },
  });
  try {
    const res = await h.fetch("/workflows/trigger", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: { kind: "lifecycle", event: "stop" },
        cwd: process.cwd(),
      }),
    });
    if (res.status !== 200) {
      throw new Error(`unexpected status ${String(res.status)}: ${await res.text()}`);
    }

    const row = h.services.db
      .query<
        { session_id: string | null; kind: string },
        []
      >("SELECT session_id, kind FROM session_events")
      .get();
    expect(row).toEqual({ session_id: null, kind: "session.stop" });

    const get = await h.fetch("/session-events?kind_prefix=session.");
    expect(get.status).toBe(200);
    const body: unknown = await get.json();
    const parsed = SessionEventsListResponseSchema.parse(body);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]?.session_id).toBeNull();
  } finally {
    h.stop();
  }
});

test("a session-start trigger resolving a note records continuity.boot_pickup with ref_path, first-moves meta, and related_session_id parsed from the note's session stamp", async () => {
  const { harness: h, repo } = await bootPickupHarness();
  try {
    mkdirSync(join(repo, "docs/notes"), { recursive: true });
    const notePath = join(repo, "docs/notes/maestro-continuation-2026-05-05.md");
    const related = "123e4567-e89b-12d3-a456-426614174000";
    writeFileSync(notePath, `<!-- penumbra:session ${related} -->\nBoot body\n`);

    const res = await h.fetch("/workflows/trigger", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: { kind: "lifecycle", event: "session-start" },
        cwd: repo,
        session_id: "s-new",
      }),
    });

    if (res.status !== 200) {
      throw new Error(`unexpected status ${String(res.status)}: ${await res.text()}`);
    }
    const row = h.services.db
      .query<
        {
          session_id: string | null;
          related_session_id: string | null;
          kind: string;
          ref_path: string | null;
          meta_json: string | null;
        },
        []
      >(
        "SELECT session_id, related_session_id, kind, ref_path, meta_json FROM session_events WHERE kind='continuity.boot_pickup'",
      )
      .get();
    expect(row?.session_id).toBe("s-new");
    expect(row?.related_session_id).toBe(related);
    expect(row?.kind).toBe("continuity.boot_pickup");
    expect(row?.ref_path).toBe(realpathSync(notePath));
    const meta: unknown = row?.meta_json ? JSON.parse(row.meta_json) : null;
    if (typeof meta !== "object" || meta === null) throw new Error("expected boot pickup meta");
    const firstMoves = (meta as { first_moves?: unknown }).first_moves;
    if (typeof firstMoves !== "object" || firstMoves === null) {
      throw new Error("expected first_moves object");
    }
    expect(typeof (firstMoves as { head_sha?: unknown }).head_sha).toBe("string");
  } finally {
    h.stop();
  }
});

test("a title-first continuation note can still link related_session_id from the first five lines", async () => {
  const { harness: h, repo } = await bootPickupHarness();
  try {
    mkdirSync(join(repo, "docs/notes"), { recursive: true });
    const notePath = join(repo, "docs/notes/maestro-continuation-2026-05-07.md");
    const related = "123e4567-e89b-12d3-a456-426614174111";
    writeFileSync(notePath, `# Continuation\n\n<!-- penumbra:session ${related} -->\nBoot body\n`);

    const res = await h.fetch("/workflows/trigger", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: { kind: "lifecycle", event: "session-start" },
        cwd: repo,
        session_id: "s-new",
      }),
    });

    if (res.status !== 200) {
      throw new Error(`unexpected status ${String(res.status)}: ${await res.text()}`);
    }
    const row = h.services.db
      .query<
        { related_session_id: string | null; ref_path: string | null },
        []
      >("SELECT related_session_id, ref_path FROM session_events WHERE kind='continuity.boot_pickup'")
      .get();
    expect(row).toEqual({ related_session_id: related, ref_path: realpathSync(notePath) });
  } finally {
    h.stop();
  }
});

test("boot pickup record failure is reported false so a later matched workflow can retry once", async () => {
  const { harness: h, repo } = await bootPickupHarness([
    "maestro-context-prime-a",
    "maestro-context-prime-b",
  ]);
  const sessionEventLog = h.services.sessionEventLog;
  const originalRecord = sessionEventLog.record.bind(sessionEventLog);
  let bootPickupAttempts = 0;
  sessionEventLog.record = (event): void => {
    if (event.kind === "continuity.boot_pickup") {
      bootPickupAttempts += 1;
      if (bootPickupAttempts === 1) {
        throw new Error("simulated record failure");
      }
    }
    originalRecord(event);
  };
  try {
    mkdirSync(join(repo, "docs/notes"), { recursive: true });
    writeFileSync(join(repo, "docs/notes/maestro-continuation-2026-05-08.md"), "Boot body\n");

    const res = await h.fetch("/workflows/trigger", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: { kind: "lifecycle", event: "session-start" },
        cwd: repo,
        session_id: "s-new",
      }),
    });

    if (res.status !== 200) {
      throw new Error(`unexpected status ${String(res.status)}: ${await res.text()}`);
    }
    const row = h.services.db
      .query<
        { count: number },
        []
      >("SELECT COUNT(*) AS count FROM session_events WHERE kind='continuity.boot_pickup'")
      .get();
    expect(bootPickupAttempts).toBe(2);
    expect(row?.count).toBe(1);
  } finally {
    sessionEventLog.record = originalRecord;
    h.stop();
  }
});

test("related_session_id is null, not an error, when the note carries no stamp", async () => {
  const { harness: h, repo } = await bootPickupHarness();
  try {
    mkdirSync(join(repo, "docs/notes"), { recursive: true });
    const notePath = join(repo, "docs/notes/maestro-continuation-2026-05-06.md");
    writeFileSync(notePath, "Boot body without stamp\n");

    const res = await h.fetch("/workflows/trigger", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: { kind: "lifecycle", event: "session-start" },
        cwd: repo,
        session_id: "s-new",
      }),
    });

    if (res.status !== 200) {
      throw new Error(`unexpected status ${String(res.status)}: ${await res.text()}`);
    }
    const row = h.services.db
      .query<
        { related_session_id: string | null; ref_path: string | null },
        []
      >("SELECT related_session_id, ref_path FROM session_events WHERE kind='continuity.boot_pickup'")
      .get();
    expect(row).toEqual({ related_session_id: null, ref_path: realpathSync(notePath) });
  } finally {
    h.stop();
  }
});
