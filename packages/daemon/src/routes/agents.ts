import { z } from 'zod';
import type { Services } from '@penumbra/core';
import {
  AgentPerformanceMarkdownParseInputSchema,
  AgentPerformanceRowSchema,
  AgentPerformanceCaptureFromDispatchSchema,
  AgentPerformanceCaptureFromReconcilerSchema,
  AgentRankInputSchema,
  AgentPerformanceWriter,
  ImportMarkdownResultSchema,
  RecordOperatorAgentPerformanceInputSchema,
  captureAgentPerformanceFromDispatch,
  captureAgentPerformanceFromReconciler,
  parseAgentPerformanceMarkdownRows,
  recordOperatorAgentPerformance,
  renderAgentPerformanceMarkdown,
  routeAgent,
} from '@penumbra/core';
import { readSubscriptionPressure } from '@penumbra/core';
import { AgentRecommendInputSchema } from '@penumbra/core';
import { routeForRole } from '@penumbra/core';

import { json } from './_helpers.js';
const AgentRouteForQuerySchema = z.object({
  role: z.string().min(1),
  window_days: z.coerce.number().int().positive().max(365).optional(),
  min_samples: z.coerce.number().int().positive().max(1000).optional(),
  agent_kind: z.enum(['coding', 'long_lived']).optional(),
});

export async function agentsPerformanceReconcilerRoute(req: Request, services: Services): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = AgentPerformanceCaptureFromReconcilerSchema.safeParse(raw);
  if (!parsed.success) return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  try {
    const performance = captureAgentPerformanceFromReconciler({
      db: services.db,
      uuid: services.uuid,
      clock: services.clock,
      input: parsed.data,
    });
    return json({ performance });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('handoff not found:')) {
      return json({ error: { code: 'not_found', message: err.message } }, 404);
    }
    throw err;
  }
}

export async function agentsPerformanceDispatchRoute(req: Request, services: Services): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = AgentPerformanceCaptureFromDispatchSchema.safeParse(raw);
  if (!parsed.success) return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  try {
    const performance = captureAgentPerformanceFromDispatch({
      db: services.db,
      uuid: services.uuid,
      clock: services.clock,
      input: parsed.data,
    });
    return json({ performance });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('handoff not found:')) {
      return json({ error: { code: 'not_found', message: err.message } }, 404);
    }
    throw err;
  }
}

export async function agentsPerformanceOperatorRoute(req: Request, services: Services): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = RecordOperatorAgentPerformanceInputSchema.safeParse(raw);
  if (!parsed.success) return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  try {
    const performance = recordOperatorAgentPerformance({
      db: services.db,
      uuid: services.uuid,
      clock: services.clock,
      input: parsed.data,
    });
    return json({ performance });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('handoff not found:')) {
      return json({ error: { code: 'not_found', message: err.message } }, 404);
    }
    return internalError(err);
  }
}

export async function agentsPerformanceImportMarkdownRoute(req: Request, services: Services): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = AgentPerformanceMarkdownParseInputSchema.safeParse(raw);
  if (!parsed.success) return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  try {
    const rows = parseAgentPerformanceMarkdownRows(parsed.data);
    const writer = new AgentPerformanceWriter(services.db);
    for (const row of rows) writer.upsert(row);
    // AgentPerformanceWriter is a replace-on-conflict upsert keyed by handoff_id, so imports are counted as imported.
    const result = ImportMarkdownResultSchema.parse({ imported: rows.length, skipped: 0 });
    return json(result);
  } catch (err) {
    if (isImportValidationError(err)) {
      return json({ error: { code: 'invalid_params', message: err.message } }, 400);
    }
    return internalError(err);
  }
}

export async function agentsPerformanceMarkdownRoute(_req: Request, services: Services): Promise<Response> {
  try {
    const rows = services.db.query<ReturnType<typeof AgentPerformanceRowSchema.parse>, []>(
      'SELECT * FROM agent_performance ORDER BY ts ASC',
    ).all();
    const markdown = renderAgentPerformanceMarkdown(rows, { generatedAt: services.clock() });
    return new Response(markdown, {
      status: 200,
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
    });
  } catch (err) {
    return internalError(err);
  }
}

export async function agentsRankRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const parsed = AgentRankInputSchema.safeParse({
    task_type: url.searchParams.get('task_type') ?? undefined,
    since: url.searchParams.get('since') ?? undefined,
    min_samples: url.searchParams.get('min_samples') ?? undefined,
    agent_kind: url.searchParams.get('agent_kind') ?? undefined,
    include_neutral: url.searchParams.get('include_neutral') ?? undefined,
    include_cost: url.searchParams.get('include_cost') ?? undefined,
  });
  if (!parsed.success) return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  const out = routeAgent({
    db: services.db,
    detail: 'rank',
    taskType: parsed.data.task_type,
    since: parsed.data.since,
    minSamples: parsed.data.min_samples,
    agentKind: parsed.data.agent_kind,
    includeNeutral: parsed.data.include_neutral,
    includeCost: parsed.data.include_cost,
    now: services.clock(),
  });
  if (out.detail !== 'rank') throw new Error('unexpected routeAgent detail for agentsRankRoute');
  return json(out.candidates);
}

export async function agentsRecommendRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const parsed = AgentRecommendInputSchema.safeParse({
    task_type: url.searchParams.get('task_type') ?? undefined,
    risk_class: url.searchParams.get('risk_class') ?? undefined,
    window_days: url.searchParams.get('window_days') ?? undefined,
    agent_kind: url.searchParams.get('agent_kind') ?? undefined,
  });
  if (!parsed.success) return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  const out = routeAgent({
    db: services.db,
    detail: 'summary',
    taskType: parsed.data.task_type as any,
    riskClass: parsed.data.risk_class,
    windowDays: parsed.data.window_days,
    agentKind: parsed.data.agent_kind,
    now: services.clock(),
  });
  if (out.detail !== 'summary') throw new Error('unexpected routeAgent detail for agentsRecommendRoute');
  return json(out.recommendations);
}

export async function agentsRouteForRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const parsed = AgentRouteForQuerySchema.safeParse({
    role: url.searchParams.get('role') ?? undefined,
    window_days: url.searchParams.get('window_days') ?? undefined,
    min_samples: url.searchParams.get('min_samples') ?? undefined,
    agent_kind: url.searchParams.get('agent_kind') ?? undefined,
  });
  if (!parsed.success) return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  const agentchatConfig = services.agentchatConfig;
  if (!agentchatConfig) return json({ error: { code: 'invalid_params', message: 'agentchat config unavailable' } }, 400);
  return json(routeForRole({
    db: services.db,
    role: parsed.data.role,
    windowDays: parsed.data.window_days,
    minSamples: parsed.data.min_samples,
    agentKind: parsed.data.agent_kind,
    pressureSnapshot: readSubscriptionPressure(services.db),
    agentchatRoles: { agents: agentchatConfig.agents ?? [] },
  }));
}

function internalError(err: unknown): Response {
  return json({
    error: {
      code: 'internal_error',
      message: err instanceof Error ? err.message : String(err),
    },
  }, 500);
}

function isImportValidationError(err: unknown): err is Error {
  return err instanceof Error
    && (
      err.message.startsWith('invalid agent performance markdown input:')
      || err.message.startsWith('invalid agent performance markdown row at line ')
    );
}
