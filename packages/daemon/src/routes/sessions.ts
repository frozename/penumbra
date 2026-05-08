import type { Services } from '@penumbra/core';
import { bodyJson, json } from './_helpers.js';

export async function sessionsTouchRoute(req: Request, services: Services): Promise<Response> {
  const raw = await bodyJson(req);
  if (!raw || typeof raw !== 'object') {
    return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);
  }
  const body = raw as { session_id?: unknown; project_id?: unknown; ts?: unknown };
  const sessionId = body.session_id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return json({ error: { code: 'bad_request', message: 'session_id required' } }, 400);
  }
  const ts = typeof body.ts === 'string' && body.ts.length > 0
    ? body.ts
    : new Date().toISOString();
  const projectId = typeof body.project_id === 'string' && body.project_id.length > 0
    ? body.project_id
    : null;

  const db = (services as any).db as import('bun:sqlite').Database;
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
  db: import('bun:sqlite').Database,
  sessionId: string,
): string | null {
  const row = db
    .query<{ session_start_at: string }, [string]>(
      'SELECT session_start_at FROM claude_code_sessions WHERE session_id = ?',
    )
    .get(sessionId);
  return row?.session_start_at ?? null;
}
