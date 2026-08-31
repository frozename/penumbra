import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { SessionEventsListResponseSchema } from "@penumbra/api-contract";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

function startHarness(opts: { workflowRegistry?: Services["workflowRegistry"] } = {}): Harness {
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

function jsonHeaders(): HeadersInit {
  return { "content-type": "application/json" };
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

    expect(res.status).toBe(200);
    const get = await h.fetch("/session-events?session_id=s-string-meta");
    const body = (await get.json()) as { events: { meta: unknown }[] };
    expect(body.events[0]?.meta).toBe("plain meta");
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
    const body = (await res.json()) as { error?: string; message?: string };
    expect(body.error).toBe("meta_too_large");
    expect(body.message).toContain("meta JSON must be <= 8192 bytes");
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { session_id: string; kind: string; meta: unknown }[];
    };
    expect(body.events.map((event) => event.kind)).toEqual([
      "continuity.boot_pickup",
      "continuity.draft_composed",
    ]);
    expect(body.events[0]!.meta).toEqual({ n: 2 });
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
    expect(res.status).toBe(200);

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
    expect(res.status).toBe(200);

    const row = h.services.db
      .query<
        { session_id: string | null; kind: string },
        []
      >("SELECT session_id, kind FROM session_events")
      .get();
    expect(row).toEqual({ session_id: null, kind: "session.stop" });

    const get = await h.fetch("/session-events?kind_prefix=session.");
    expect(get.status).toBe(200);
    const body = await get.json();
    const parsed = SessionEventsListResponseSchema.parse(body);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]?.session_id).toBeNull();
  } finally {
    h.stop();
  }
});
