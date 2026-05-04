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
  rankAgents,
  recordOperatorAgentPerformance,
  renderAgentPerformanceMarkdown,
} from '@penumbra/core';
import { AgentRecommendInputSchema } from '../../../core/src/schemas/agent-recommend.js';
import { getAgentRecommendationsFromInput } from '../../../core/src/readers/agent-recommend.js';

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
    include_neutral: url.searchParams.get('include_neutral') ?? undefined,
    include_cost: url.searchParams.get('include_cost') ?? undefined,
  });
  if (!parsed.success) return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  return json(rankAgents(services.db, parsed.data, services.clock));
}

export async function agentsRecommendRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const parsed = AgentRecommendInputSchema.safeParse({
    task_type: url.searchParams.get('task_type') ?? undefined,
    risk_class: url.searchParams.get('risk_class') ?? undefined,
    window_days: url.searchParams.get('window_days') ?? undefined,
  });
  if (!parsed.success) return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  return json(getAgentRecommendationsFromInput(services.db, parsed.data, services.clock));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
