import { loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { lookupSessionStart, sessionsTouchRoute } from "@src/routes/sessions.js";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // Optional Homebrew SQLite is unavailable in some CI images.
  }
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makeServices(db: Database): Services {
  // sessionsTouchRoute only reads services.db; the full daemon service graph is irrelevant here.
  return { db } as unknown as Services;
}

test("POST /sessions/touch creates a row on first call", async () => {
  const db = freshDb();
  const services = makeServices(db);
  const req = new Request("http://localhost/sessions/touch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: "s1", project_id: "penumbra", ts: "2026-05-05T08:00:00Z" }),
  });
  const res = await sessionsTouchRoute(req, services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(true);

  const row = db
    .query(
      "SELECT session_id, session_start_at, last_seen_at, project_id FROM claude_code_sessions WHERE session_id = ?",
    )
    .get("s1") as {
    session_id: string;
    session_start_at: string;
    last_seen_at: string;
    project_id: string | null;
  };
  expect(row.session_start_at).toBe("2026-05-05T08:00:00Z");
  expect(row.last_seen_at).toBe("2026-05-05T08:00:00Z");
  expect(row.project_id).toBe("penumbra");
});

test("POST /sessions/touch updates last_seen_at, preserves session_start_at", async () => {
  const db = freshDb();
  const services = makeServices(db);

  await sessionsTouchRoute(
    new Request("http://localhost/sessions/touch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "s2",
        project_id: "penumbra",
        ts: "2026-05-05T08:00:00Z",
      }),
    }),
    services,
  );
  await sessionsTouchRoute(
    new Request("http://localhost/sessions/touch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s2", ts: "2026-05-05T09:30:00Z" }),
    }),
    services,
  );

  const row = db
    .query(
      "SELECT session_start_at, last_seen_at, project_id FROM claude_code_sessions WHERE session_id = ?",
    )
    .get("s2") as { session_start_at: string; last_seen_at: string; project_id: string | null };
  expect(row.session_start_at).toBe("2026-05-05T08:00:00Z");
  expect(row.last_seen_at).toBe("2026-05-05T09:30:00Z");
  expect(row.project_id).toBe("penumbra");
});

test("POST /sessions/touch missing session_id returns 400", async () => {
  const db = freshDb();
  const services = makeServices(db);
  const res = await sessionsTouchRoute(
    new Request("http://localhost/sessions/touch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: "p" }),
    }),
    services,
  );
  expect(res.status).toBe(400);
});

test("lookupSessionStart returns the stored start time", async () => {
  const db = freshDb();
  const services = makeServices(db);
  await sessionsTouchRoute(
    new Request("http://localhost/sessions/touch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s3", ts: "2026-05-05T07:00:00Z" }),
    }),
    services,
  );
  expect(lookupSessionStart(db, "s3")).toBe("2026-05-05T07:00:00Z");
  expect(lookupSessionStart(db, "missing")).toBeNull();
});
