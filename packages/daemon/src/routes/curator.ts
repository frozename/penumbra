import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { Services } from '@penumbra/core';
import { json } from './_helpers.js';

export function queryCuratorPatterns(
  db: Database,
  opts: { status?: string },
): { patterns: unknown[] } {
  const status = opts.status ?? 'approved';
  const rows =
    status === 'all'
      ? db
          .prepare(
            `SELECT pattern_id, pattern, reason, status, proposed_by, proposed_at, enabled
             FROM curator_ephemera_patterns ORDER BY proposed_at DESC`,
          )
          .all()
      : db
          .prepare(
            `SELECT pattern_id, pattern, reason, status, proposed_by, proposed_at, enabled
             FROM curator_ephemera_patterns WHERE status=? ORDER BY proposed_at DESC`,
          )
          .all(status);
  return { patterns: rows };
}

export function insertCuratorPattern(
  db: Database,
  opts: { pattern: string; reason: string; proposed_by?: string },
): { pattern_id: string } {
  const pattern_id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO curator_ephemera_patterns (pattern_id, pattern, reason, status, proposed_by, proposed_at, enabled)
     VALUES (?, ?, ?, 'queued', ?, ?, 0)`,
  ).run(pattern_id, opts.pattern, opts.reason, opts.proposed_by ?? 'mcp-caller', Date.now());
  return { pattern_id };
}

export function approveCuratorPattern(
  db: Database,
  pattern_id: string,
): { ok: true; pattern_id: string } | null {
  const result = db
    .prepare(`UPDATE curator_ephemera_patterns SET status='approved', enabled=1 WHERE pattern_id=?`)
    .run(pattern_id);
  if (result.changes === 0) return null;
  return { ok: true, pattern_id };
}

export function disableCuratorPattern(
  db: Database,
  pattern_id: string,
): { ok: true; pattern_id: string } | null {
  const result = db
    .prepare(`UPDATE curator_ephemera_patterns SET enabled=0 WHERE pattern_id=?`)
    .run(pattern_id);
  if (result.changes === 0) return null;
  return { ok: true, pattern_id };
}

const ListQuerySchema = z.object({
  status: z.enum(['queued', 'approved', 'rejected', 'all']).optional(),
});

const AddBodySchema = z.object({
  pattern: z.string().min(1),
  reason: z.string().min(1),
  proposed_by: z.string().optional(),
});

export async function curatorPatternsListRoute(
  req: Request,
  services: Services,
): Promise<Response> {
  const url = new URL(req.url);
  const parsed = ListQuerySchema.safeParse({
    status: url.searchParams.get('status') ?? undefined,
  });
  if (!parsed.success) {
    return json({ error: { code: 'validation_error', message: 'invalid query parameters' } }, 400);
  }
  return json(queryCuratorPatterns(services.db, parsed.data));
}

export async function curatorPatternsAddRoute(
  req: Request,
  services: Services,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const parsed = AddBodySchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: { code: 'validation_error', message: 'invalid body' } }, 400);
  }
  return json(insertCuratorPattern(services.db, parsed.data));
}

export async function curatorPatternsApproveRoute(
  _req: Request,
  services: Services,
  pattern_id: string,
): Promise<Response> {
  const result = approveCuratorPattern(services.db, pattern_id);
  if (!result) return json({ error: 'not_found' }, 404);
  return json(result);
}

export async function curatorPatternsDisableRoute(
  _req: Request,
  services: Services,
  pattern_id: string,
): Promise<Response> {
  const result = disableCuratorPattern(services.db, pattern_id);
  if (!result) return json({ error: 'not_found' }, 404);
  return json(result);
}
