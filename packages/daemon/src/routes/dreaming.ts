import { z } from 'zod';
import type { Services } from '@penumbra/core';
import { listPendingDreamActionsQuery } from '../dreaming/digest.js';
import { json } from './_helpers.js';

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function dreamingPendingActionsRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return json({ error: { code: 'validation_error', message: 'invalid query parameters' } }, 400);
  }
  return json(listPendingDreamActionsQuery(services.db, parsed.data));
}

import { revertDreamAction } from '../dreaming/reembed.js';

export async function dreamingHealthRoute(req: Request, services: Services): Promise<Response> {
  const db = services.db;
  const now = Date.now();
  const uptimeMs = now - (services.clock?.().getTime() || now);
  
  const currentRunning = db.prepare(
    'SELECT cycle_id, started_at, phases_run FROM dream_cycles WHERE outcome = \"running\" ORDER BY started_at DESC LIMIT 1'
  ).get() as { cycle_id: string; started_at: number; phases_run: string } | null;
  
  const current_running_cycle = currentRunning ? {
    cycle_id: currentRunning.cycle_id,
    started_at: currentRunning.started_at,
    phases_completed: JSON.parse(currentRunning.phases_run || '[]')
  } : null;

  const yesterdayMs = now - 24 * 60 * 60 * 1000;
  
  const cycles_in_last_24h = (db.prepare(
    'SELECT COUNT(*) as c FROM dream_cycles WHERE started_at >= ?'
  ).get(yesterdayMs) as {c: number}).c;

  const cycles_crashed_24h = (db.prepare(
    'SELECT COUNT(*) as c FROM dream_cycles WHERE started_at >= ? AND outcome = \"crashed\"'
  ).get(yesterdayMs) as {c: number}).c;

  const alerts = [];
  if (uptimeMs > 24 * 60 * 60 * 1000 && cycles_in_last_24h === 0) {
    alerts.push('dream.health.no_cycles_24h');
  }
  if (cycles_crashed_24h >= 3) {
    alerts.push('dream.health.crashed_high');
  }

  return json({
    current_running_cycle,
    cycles_in_last_24h,
    cycles_crashed_24h,
    alerts
  });
}

export async function dreamingRevertRoute(req: Request, services: Services): Promise<Response> {
  const body = await req.json() as { action_id?: string; cascade?: 'none' | 'force' };
  if (!body.action_id) return json({ error: 'missing action_id' }, 400);
  try {
    revertDreamAction(services.db, body.action_id, body.cascade || 'none');
    return json({ ok: true });
  } catch (err: any) {
    if (err.message && err.message.includes('has_dependents')) {
      return json({ error: 'has_dependents', details: err.message }, 409);
    }
    return json({ error: err.message }, 500);
  }
}
