import type { Services } from '@penumbra/core';
import { resolveProjectId } from '@penumbra/core';
import type { Registry, TemplateVarContext } from '../../../workflows/src/index.js';
import type { WorkflowSpec } from '../../../workflows/src/schema.js';
import {
  composeRecall,
  executeWorkflow,
  evaluateTriggerEvent,
  evaluateStateThresholds,
  computeStateMetrics,
} from '../../../workflows/src/index.js';
import { lookupSessionStart } from './sessions.js';

const SESSION_START_FALLBACK_MS = 8 * 60 * 60 * 1000; // 8h lookback for ad-hoc/manual runs.

function resolveSessionStart(
  db: import('bun:sqlite').Database | undefined,
  sessionId: string | null | undefined,
  now: number,
): string {
  if (sessionId && db) {
    const stored = lookupSessionStart(db, sessionId);
    if (stored) return stored;
  }
  return new Date(now - SESSION_START_FALLBACK_MS).toISOString();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// The Services interface in @penumbra/core types workflowRegistry with the default
// `WorkflowRegistry<unknown, unknown>` because core can't depend on the workflows
// package. Cast to the concrete Registry at the route boundary so spec types flow.
function getRegistry(services: Services): Registry | undefined {
  return services.workflowRegistry as Registry | undefined;
}

export async function workflowsListRoute(_req: Request, services: Services): Promise<Response> {
  const reg = getRegistry(services);
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

export async function workflowsRunRoute(req: Request, services: Services): Promise<Response> {
  const reg = getRegistry(services);
  if (!reg) return json({ error: { code: 'no_registry', message: 'workflow registry not configured' } }, 500);

  const body = (await req.json().catch(() => null)) as
    | { name?: string; cwd?: string; session_id?: string | null }
    | null;
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

  const start = Date.now();
  const sessionStart = resolveSessionStart((services as any).db, body?.session_id ?? null, start);
  const templateCtx: TemplateVarContext = {
    now: () => new Date(),
    project,
    sessionStart,
    tz: process.env.TZ ?? 'UTC',
  };
  const agentRegistry = (services as any).agentRegistry
    ? { listAgents: () => ((services as any).agentRegistry as string[]).map((name) => ({ name })) }
    : undefined;

  const bundle = await composeRecall({
    db: (services as any).db,
    embedder: (services as any).embedder,
    cwd,
    project,
    sources: entry.spec.recall,
    budgetTokens: entry.spec.recall_budget_tokens,
    agentRegistry,
    templateCtx,
  });

  const result = await executeWorkflow({
    spec: entry.spec,
    bundle,
    fn: entry.fn,
    storageRoot: (services as any).storageRoot ?? (services as any).settings?.storageRoot ?? '/tmp',
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

export async function workflowsTriggerRoute(req: Request, services: Services): Promise<Response> {
  const reg = getRegistry(services);
  if (!reg) return json({ matched: [], additionalContext: null });
  const body = (await req.json().catch(() => null)) as
    | {
        event?: any;
        cwd?: string;
        hookContext?: { tool_name?: string | null; file_path?: string | null };
      }
    | null;
  const sessionIdFromBody = (body as { session_id?: string | null } | null)?.session_id ?? null;
  const filePathFromBody =
    typeof body?.hookContext?.file_path === 'string' ? body.hookContext.file_path : null;
  if (!body?.event) return json({ error: { code: 'bad_request', message: 'event required' } }, 400);
  const matched = evaluateTriggerEvent(reg, body.event).filter((spec: WorkflowSpec) => {
    for (const trigger of spec.triggers) {
      if (trigger.kind !== 'lifecycle') continue;
      if (trigger.event !== body.event.event) continue;
      const filter = trigger.filter;
      if (!filter?.tool_name) return true;
      const toolName = body.hookContext?.tool_name;
      if (typeof toolName !== 'string') return false;
      return filter.tool_name.includes(toolName);
    }
    return false;
  });

  const cwd = body.cwd ?? process.cwd();
  let project = 'unknown';
  try {
    const resolved = resolveProjectId({ cwd });
    if (resolved.project_id) project = resolved.project_id;
  } catch {}

  const additionalContextParts: string[] = [];
  for (const spec of matched) {
    const entry = reg.getEntry(spec.name);
    if (!entry) continue;
    const start = Date.now();
    const sessionStart = resolveSessionStart((services as any).db, sessionIdFromBody, start);
    const templateCtx: TemplateVarContext = {
      now: () => new Date(),
      project,
      sessionStart,
      tz: process.env.TZ ?? 'UTC',
      cwd,
      repoRoot: cwd,
      filePath: filePathFromBody ?? undefined,
    };
    const agentRegistry = (services as any).agentRegistry
      ? { listAgents: () => ((services as any).agentRegistry as string[]).map((name) => ({ name })) }
      : undefined;
    const bundle = await composeRecall({
      db: (services as any).db,
      embedder: (services as any).embedder,
      cwd,
      project,
      sources: entry.spec.recall,
      budgetTokens: entry.spec.recall_budget_tokens,
      agentRegistry,
      templateCtx,
    });
    const result = await executeWorkflow({
      spec: entry.spec,
      bundle,
      fn: entry.fn,
      storageRoot: (services as any).storageRoot ?? (services as any).settings?.storageRoot ?? '/tmp',
      captureCtx: {
        db: (services as any).db,
        project,
        sessionId: 'hook-trigger',
        userId: 'penumbra',
        machineId: process.env.HOSTNAME ?? 'unknown',
      },
      observationCtx: {
        sessionId: sessionIdFromBody,
        projectId: project !== 'unknown' ? project : null,
      },
      templateCtx,
    });
    if (result.sessionReminder) additionalContextParts.push(result.sessionReminder);
  }

  const additionalContext = additionalContextParts.length ? additionalContextParts.join('\n\n') : null;
  return json({ matched: matched.map((s) => s.name), additionalContext });
}

export async function workflowsHistoryRoute(req: Request, services: Services): Promise<Response> {
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

export async function workflowsSuggestRoute(req: Request, services: Services): Promise<Response> {
  const reg = getRegistry(services);
  if (!reg) return json({ suggestions: [], metrics: { 'queue-idle-min': 0, 'time-since-last-handoff-min': 0, 'pending-handoffs': 0, 'commits-since-last-handoff': 0 } });
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
