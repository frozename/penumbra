import type { Services } from "@penumbra/core";

import { bodyJson, json } from "./_helpers.js";
export async function sessionsTouchRoute(req: Request, services: Services): Promise<Response> {
  const raw = await bodyJson(req);
  if (!raw || typeof raw !== "object") {
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );
  }
  const body = raw as { session_id?: unknown; project_id?: unknown; ts?: unknown };
  const sessionId = body.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return json({ error: { code: "bad_request", message: "session_id required" } }, 400);
  }
  const ts = typeof body.ts === "string" && body.ts.length > 0 ? body.ts : new Date().toISOString();
  const projectId =
    typeof body.project_id === "string" && body.project_id.length > 0 ? body.project_id : null;

  const { db } = services;
  db.prepare(
    `INSERT INTO claude_code_sessions (session_id, session_start_at, last_seen_at, project_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       project_id = COALESCE(excluded.project_id, claude_code_sessions.project_id)`,
  ).run(sessionId, ts, ts, projectId);

  return json({ ok: true });
}

export function lookupSessionStart(
  db: import("bun:sqlite").Database,
  sessionId: string,
): string | null {
  const row = db
    .query<
      { session_start_at: string },
      [string]
    >("SELECT session_start_at FROM claude_code_sessions WHERE session_id = ?")
    .get(sessionId);
  return row?.session_start_at ?? null;
}

const SESSION_BUDGET_MAX = 6;
const SESSION_BUDGET_SOFT_WARN_PCT = 0.8;
const NO_SESSION_PROJECT = { id: "—", name: "no project" };

export function sessionCurrentRoute(_req: Request, services: Services): Response {
  const { db } = services;

  // Latest seen claude-code session is the working session.
  const latest = db
    .query<{ session_id: string; session_start_at: string; project_id: string | null }, []>(
      `SELECT session_id, session_start_at, project_id
       FROM claude_code_sessions
       ORDER BY last_seen_at DESC
       LIMIT 1`,
    )
    .get();

  // Aggregate chain counts. listChains caps at limit; pass a generous one.
  const allChains = services.chainReader.listChains({ limit: 5000, offset: 0 });
  let dispatched = 0;
  let resolved = 0;
  let failed = 0;
  for (const c of allChains) {
    const s = (c as { latest_status?: string }).latest_status;
    if (s === "dispatched") dispatched += 1;
    else if (s === "completed") resolved += 1;
    else if (s === "failed") failed += 1;
  }

  const project = latest?.project_id
    ? { id: latest.project_id, name: latest.project_id }
    : NO_SESSION_PROJECT;

  return json({
    id: latest?.session_id ?? "no-session",
    project,
    started_at: latest?.session_start_at ?? new Date(0).toISOString(),
    dispatched,
    resolved,
    failed,
    budget: {
      current: dispatched,
      max_concurrent: SESSION_BUDGET_MAX,
      soft_warn_pct: SESSION_BUDGET_SOFT_WARN_PCT,
    },
  });
}
