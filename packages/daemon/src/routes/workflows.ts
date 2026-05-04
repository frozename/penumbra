import type { Services } from '@penumbra/core';
import { resolveProjectId } from '@penumbra/core';
import type { Registry } from '@penumbra/workflows';
import {
  composeRecall,
  executeWorkflow,
  evaluateTriggerEvent,
  evaluateStateThresholds,
  computeStateMetrics,
} from '@penumbra/workflows';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type WorkflowServices = Services & { workflowRegistry?: Registry };

export async function workflowsListRoute(_req: Request, services: WorkflowServices): Promise<Response> {
  const reg = services.workflowRegistry;
  if (!reg) return json({ workflows: [] });
  return json({
    workflows: reg.list().map((spec) => ({
      name: spec.name,
      description: spec.description,
      triggers: spec.triggers,
    })),
    errors: reg.errors,
  });
}

export async function workflowsRunRoute(req: Request, services: WorkflowServices): Promise<Response> {
  const reg = services.workflowRegistry;
  if (!reg) return json({ error: { code: 'no_registry', message: 'workflow registry not configured' } }, 500);

  const body = (await req.json().catch(() => null)) as { name?: string; cwd?: string } | null;
  const name = body?.name;
  if (!name) return json({ error: { code: 'bad_request', message: 'name required' } }, 400);

  const entry = reg.getEntry(name);
  if (!entry) return json({ error: { code: 'not_found', message: `workflow ${name} not found` } }, 404);

  const cwd = body?.cwd ?? process.cwd();
  let project = 'unknown';
  try {
    const resolved = resolveProjectId({ cwd });
    if (resolved.project_id) project = resolved.project_id;
  } catch {}

  const bundle = await composeRecall({
    db: (services as any).db,
    embedder: (services as any).embedder,
    cwd,
    project,
    sources: entry.spec.recall,
    budgetTokens: entry.spec.recall_budget_tokens,
  });

  const result = await executeWorkflow({
    spec: entry.spec,
    bundle,
    fn: entry.fn,
    storageRoot: (services as any).settings?.storageRoot ?? '/tmp',
    captureCtx: {
      db: (services as any).db,
      project,
      sessionId: 'daemon-direct',
      userId: 'penumbra',
      machineId: process.env.HOSTNAME ?? 'unknown',
    },
  });
  return json(result);
}

export async function workflowsTriggerRoute(req: Request, services: WorkflowServices): Promise<Response> {
  const reg = services.workflowRegistry;
  if (!reg) return json({ matched: [] });
  const body = (await req.json().catch(() => null)) as { event?: any; cwd?: string } | null;
  if (!body?.event) return json({ error: { code: 'bad_request', message: 'event required' } }, 400);
  const matched = evaluateTriggerEvent(reg, body.event).map((s) => s.name);
  return json({ matched });
}

export async function workflowsHistoryRoute(req: Request, services: WorkflowServices): Promise<Response> {
  const url = new URL(req.url);
  const name = url.searchParams.get('name');
  if (!name) return json({ error: { code: 'bad_request', message: 'name required' } }, 400);
  const db = (services as any).db;
  const stats = db.query('SELECT * FROM workflow_stats WHERE workflow_name = ?').get(name);
  const recent = db
    .query(`SELECT ts, event_type, payload_json FROM t0_events WHERE event_type = 'workflow.outcome' AND json_extract(payload_json, '$.workflow_name') = ? ORDER BY ts DESC LIMIT 20`)
    .all(name);
  return json({ stats: stats ?? null, recent });
}

export async function workflowsSuggestRoute(req: Request, services: WorkflowServices): Promise<Response> {
  const reg = services.workflowRegistry;
  if (!reg) return json({ suggestions: [], metrics: { 'queue-idle-min': 0, 'time-since-last-handoff-min': 0, 'pending-handoffs': 0 } });
  const body = (await req.json().catch(() => ({}))) as { now?: string };
  const now = body.now ? new Date(body.now) : new Date();
  const metrics = computeStateMetrics({ db: (services as any).db, now: () => now });
  const suggestions = evaluateStateThresholds(reg, metrics).map((s) => ({
    name: s.name,
    description: s.description,
    triggers: s.triggers,
  }));
  return json({ suggestions, metrics });
}
