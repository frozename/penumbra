import {
  type SessionEvent,
  SessionEventsListResponseSchema,
  SessionNoteApproveResponseSchema,
  type SessionNoteDraft,
} from "@penumbra/api-contract";
import { type Services } from "@penumbra/core";
import {
  buildServices,
  loadSqliteVec,
  migrate,
  SessionNoteDrafts,
  WorkerTokenStore,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  drafts: SessionNoteDrafts;
  fetch(path: string, init?: RequestInit, bearer?: string): Promise<Response>;
  issueWorkerToken(worker_id?: string): string;
  stop(): void;
}

interface SeededDraft {
  draft: SessionNoteDraft;
  dir: string;
  draft_path: string;
  note_path: string;
  draftBody: string;
}

function startHarness(): Harness {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const root = mkdtempSync(join(tmpdir(), "session-notes-route-"));
  const token = "tok";
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-08-31T20:05:00.000Z"),
  });
  const handler = createDaemonFetchHandler({ services, token });
  return {
    services,
    drafts: new SessionNoteDrafts(db),
    fetch(path: string, init?: RequestInit, bearer: string = token): Promise<Response> {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${bearer}`);
      return handler(new Request(`http://x${path}`, { ...init, headers }));
    },
    issueWorkerToken(worker_id = "worker-1"): string {
      return new WorkerTokenStore(db).issue({ worker_id }, services.clock().getTime()).token;
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

function seedDraft(
  h: Harness,
  opts: { draft_id?: string; draftBody?: string; composedAt?: string; note_path?: string } = {},
): SeededDraft {
  const draft_id = opts.draft_id ?? "draft-1";
  const dir = mkdtempSync(join(tmpdir(), "session-note-draft-"));
  const skeleton_path = join(dir, "maestro-continuation-2026-08-31-pm.skeleton.md");
  const draft_path = join(dir, "maestro-continuation-2026-08-31-pm.draft.md");
  const note_path = opts.note_path ?? join(dir, "maestro-continuation-2026-08-31-pm.md");
  const draftBody = opts.draftBody ?? "draft body\n";
  writeFileSync(skeleton_path, "skeleton\n");
  writeFileSync(draft_path, draftBody);
  const draft = h.drafts.registerDraft({
    draft_id,
    session_id: "session-1",
    project_id: "project-1",
    period_key: "2026-08-31-pm",
    skeleton_path,
    draft_path,
    note_path,
    handoff_id: "handoff-1",
    composed_at: opts.composedAt ?? "2026-08-31T20:00:00.000Z",
    composed_event_id: null,
  });
  return { draft, dir, draft_path, note_path, draftBody };
}

async function listContinuityEvents(h: Harness): Promise<SessionEvent[]> {
  const res = await h.fetch("/session-events?kind_prefix=continuity.");
  if (res.status !== 200) throw new Error(`unexpected status ${String(res.status)}`);
  return SessionEventsListResponseSchema.parse(await res.json()).events;
}

test("POST /session-notes/approve without explicit approve:true is rejected with no state change", async () => {
  const h = startHarness();
  const seeded = seedDraft(h);
  try {
    const res = await h.fetch("/session-notes/approve", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ draft_id: seeded.draft.draft_id }),
    });

    expect(res.status).toBe(400);
    expect(h.drafts.get(seeded.draft.draft_id)?.status).toBe("awaiting_approval");
    expect(existsSync(seeded.note_path)).toBe(false);
  } finally {
    rmSync(seeded.dir, { recursive: true, force: true });
    h.stop();
  }
});

test("POST /session-notes/approve writes the draft body and records approved continuity telemetry", async () => {
  const h = startHarness();
  const seeded = seedDraft(h, { draftBody: "approved body\n" });
  try {
    h.services.sessionEventLog.record({
      session_id: "session-1",
      project_id: "project-1",
      cwd: "/repo",
      transcript_path: "/tmp/transcript.jsonl",
      ref_path: seeded.draft_path,
      kind: "continuity.draft_composed",
      ts: "2026-08-31T20:00:00.000Z",
      meta: { draft_id: seeded.draft.draft_id },
    });

    const res = await h.fetch("/session-notes/approve", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ draft_id: seeded.draft.draft_id, approve: true }),
    });

    expect(res.status).toBe(200);
    const rawBody = await res.json();
    const body = SessionNoteApproveResponseSchema.parse(rawBody);
    expect(rawBody).toEqual(body);
    expect(body.draft.status).toBe("approved");
    expect(readFileSync(seeded.note_path, "utf8")).toBe("approved body\n");

    const reviewed = (await listContinuityEvents(h)).find(
      (event) => event.kind === "continuity.draft_reviewed",
    );
    expect(reviewed?.ref_path).toBe(seeded.note_path);
    expect(reviewed?.meta).toEqual({
      outcome: "approved",
      draft_id: seeded.draft.draft_id,
      diff_len: 0,
      latency_ms: 300000,
    });
    expect(body.event?.id).toBe(reviewed?.id);
  } finally {
    rmSync(seeded.dir, { recursive: true, force: true });
    h.stop();
  }
});

test("POST /session-notes/approve reverts the draft when note writing fails so retry can succeed", async () => {
  const h = startHarness();
  const blockedParent = join(mkdtempSync(join(tmpdir(), "session-note-blocked-")), "parent-file");
  const blockedNotePath = join(blockedParent, "note.md");
  writeFileSync(blockedParent, "not a directory\n");
  const seeded = seedDraft(h, { note_path: blockedNotePath });
  try {
    const failed = await h.fetch("/session-notes/approve", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ draft_id: seeded.draft.draft_id, approve: true }),
    });

    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: "note_write_failed" });
    expect(h.drafts.get(seeded.draft.draft_id)?.status).toBe("awaiting_approval");
    expect(existsSync(blockedNotePath)).toBe(false);
    expect(await listContinuityEvents(h)).toHaveLength(0);

    rmSync(blockedParent, { force: true });
    const retried = await h.fetch("/session-notes/approve", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ draft_id: seeded.draft.draft_id, approve: true }),
    });

    expect(retried.status).toBe(200);
    expect(readFileSync(blockedNotePath, "utf8")).toBe(seeded.draftBody);
    expect(h.drafts.get(seeded.draft.draft_id)?.status).toBe("approved");
    expect(
      (await listContinuityEvents(h)).filter((event) => event.kind === "continuity.draft_reviewed"),
    ).toHaveLength(1);
  } finally {
    rmSync(seeded.dir, { recursive: true, force: true });
    rmSync(blockedParent, { recursive: true, force: true });
    h.stop();
  }
});

test("POST /session-notes/approve with edited body records edited outcome and diff length", async () => {
  const h = startHarness();
  const seeded = seedDraft(h, { draftBody: "old body\n" });
  try {
    const editedBody = "old body plus edits\n";
    const res = await h.fetch("/session-notes/approve", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        draft_id: seeded.draft.draft_id,
        approve: true,
        body: editedBody,
      }),
    });

    expect(res.status).toBe(200);
    expect(readFileSync(seeded.note_path, "utf8")).toBe(editedBody);
    const reviewed = (await listContinuityEvents(h)).find(
      (event) => event.kind === "continuity.draft_reviewed",
    );
    expect(reviewed?.meta).toMatchObject({
      outcome: "edited",
      draft_id: seeded.draft.draft_id,
      diff_len: editedBody.length - seeded.draftBody.length,
    });
  } finally {
    rmSync(seeded.dir, { recursive: true, force: true });
    h.stop();
  }
});

test("POST /session-notes/approve uses the stored composed_event_id when computing latency", async () => {
  const h = startHarness();
  const seeded = seedDraft(h, { draftBody: "approved body\n" });
  try {
    h.services.sessionEventLog.record({
      session_id: "session-1",
      project_id: "project-1",
      cwd: "/older",
      transcript_path: "/tmp/older.jsonl",
      ref_path: seeded.draft_path,
      kind: "continuity.draft_composed",
      ts: "2026-08-31T19:55:00.000Z",
      meta: { draft_id: seeded.draft.draft_id },
    });
    h.services.sessionEventLog.record({
      session_id: "session-1",
      project_id: "project-1",
      cwd: "/newer",
      transcript_path: "/tmp/newer.jsonl",
      ref_path: seeded.draft_path,
      kind: "continuity.draft_composed",
      ts: "2026-08-31T20:00:00.000Z",
      meta: { draft_id: seeded.draft.draft_id },
    });
    const older = h.services.db
      .query<{ id: number; related_session_id: string | null }, []>(
        `SELECT id, related_session_id FROM session_events
         WHERE cwd = '/older'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get();
    if (!older) throw new Error("older composed event was not recorded");
    h.services.db
      .prepare(`UPDATE session_note_drafts SET composed_event_id = ? WHERE draft_id = ?`)
      .run(older.id, seeded.draft.draft_id);

    const res = await h.fetch("/session-notes/approve", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ draft_id: seeded.draft.draft_id, approve: true }),
    });

    expect(res.status).toBe(200);
    const body = SessionNoteApproveResponseSchema.parse(await res.json());
    expect(body.event?.related_session_id).toBe(older.related_session_id);
    expect(body.event?.cwd).toBe("/older");
    expect(body.event?.meta).toMatchObject({ latency_ms: 600000 });
  } finally {
    rmSync(seeded.dir, { recursive: true, force: true });
    h.stop();
  }
});

test("POST /session-notes/approve clamps negative latency to zero", async () => {
  const h = startHarness();
  const seeded = seedDraft(h, { draftBody: "approved body\n" });
  try {
    h.services.sessionEventLog.record({
      session_id: "session-1",
      project_id: "project-1",
      ref_path: seeded.draft_path,
      kind: "continuity.draft_composed",
      ts: "2026-08-31T20:10:00.000Z",
      meta: { draft_id: seeded.draft.draft_id },
    });

    const res = await h.fetch("/session-notes/approve", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ draft_id: seeded.draft.draft_id, approve: true }),
    });

    expect(res.status).toBe(200);
    const body = SessionNoteApproveResponseSchema.parse(await res.json());
    expect(body.event?.meta).toMatchObject({ latency_ms: 0 });
  } finally {
    rmSync(seeded.dir, { recursive: true, force: true });
    h.stop();
  }
});

test("POST /session-notes/approve allows only one concurrent approval", async () => {
  const h = startHarness();
  const seeded = seedDraft(h, { draftBody: "original\n" });
  try {
    const [first, second] = await Promise.all([
      h.fetch("/session-notes/approve", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          draft_id: seeded.draft.draft_id,
          approve: true,
          body: "winner-a\n",
        }),
      }),
      h.fetch("/session-notes/approve", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          draft_id: seeded.draft.draft_id,
          approve: true,
        }),
      }),
    ]);
    const responses = [
      { status: first.status, body: await first.json() },
      { status: second.status, body: await second.json() },
    ];
    const statuses = responses.map((response) => response.status).sort();

    expect(statuses).toEqual([200, 409]);
    const winner = responses.find((response) => response.status === 200);
    const loser = responses.find((response) => response.status === 409);
    expect(winner).toBeDefined();
    expect(loser?.body).toEqual({ error: "conflict" });
    const winningResponse = SessionNoteApproveResponseSchema.parse(winner?.body);
    expect(readFileSync(seeded.note_path, "utf8")).toBe(
      winningResponse.draft.status === "edited" ? "winner-a\n" : "original\n",
    );
    const reviewed = (await listContinuityEvents(h)).filter(
      (event) => event.kind === "continuity.draft_reviewed",
    );
    expect(reviewed).toHaveLength(1);
  } finally {
    rmSync(seeded.dir, { recursive: true, force: true });
    h.stop();
  }
});

test("POST /session-notes/approve rejects worker-token callers before changing draft state", async () => {
  const h = startHarness();
  const seeded = seedDraft(h, { draftBody: "approved body\n" });
  try {
    const res = await h.fetch(
      "/session-notes/approve",
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ draft_id: seeded.draft.draft_id, approve: true }),
      },
      h.issueWorkerToken(),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(h.drafts.get(seeded.draft.draft_id)?.status).toBe("awaiting_approval");
    expect(existsSync(seeded.note_path)).toBe(false);
    expect(await listContinuityEvents(h)).toHaveLength(0);
  } finally {
    rmSync(seeded.dir, { recursive: true, force: true });
    h.stop();
  }
});

test("GET /session-notes/drafts rejects worker-token callers before listing drafts", async () => {
  const h = startHarness();
  const seeded = seedDraft(h, { draftBody: "approved body\n" });
  try {
    const res = await h.fetch("/session-notes/drafts", { method: "GET" }, h.issueWorkerToken());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(h.drafts.get(seeded.draft.draft_id)?.status).toBe("awaiting_approval");
    expect(existsSync(seeded.note_path)).toBe(false);
  } finally {
    rmSync(seeded.dir, { recursive: true, force: true });
    h.stop();
  }
});

test("POST /session-notes/approve returns 404 for an unknown draft", async () => {
  const h = startHarness();
  try {
    const res = await h.fetch("/session-notes/approve", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ draft_id: "missing", approve: true }),
    });

    expect(res.status).toBe(404);
  } finally {
    h.stop();
  }
});
