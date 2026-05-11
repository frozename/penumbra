import type { Services } from '@penumbra/core';
import {
  handleLongLivedApproveAction,
  handleLongLivedAudit,
  handleLongLivedInjectGoal,
  handleLongLivedPause,
  handleLongLivedPendingActions,
  handleLongLivedRejectAction,
  handleLongLivedResume,
  handleLongLivedRetire,
  handleLongLivedStateGet,
  handleLongLivedStateSet,
  handleLongLivedTicks,
} from '@penumbra/mcp';

interface LongLivedAgentListRow {
  id: string;
  display_name: string;
  status: string;
  schedule_cron: string | null;
  last_tick_started_at: number | null;
  last_tick_completed_at: number | null;
  last_tick_outcome: string | null;
  last_intent_summary: string | null;
  consecutive_failures: number;
  circuit_breaker_threshold: number;
  retired_at: number | null;
  subscriptions_json: string | null;
  mcp_allowlist_json: string;
  approval_required_globs_json: string;
  cooldown_overrides_json: string;
  working_memory_json: string;
}

interface LongLivedAgentRow extends LongLivedAgentListRow {
  degraded_reason: string | null;
  bounds_wall_clock_ms: number | null;
  bounds_cost_cents: number | null;
  bounds_max_sub_dispatches: number | null;
  standing_brief: string;
  created_at: number;
  updated_at: number;
}

interface LongLivedTickRow {
  id: string;
  agent_id: string;
  chain_id: string | null;
  trigger_kind: string;
  trigger_payload_json: string | null;
  intent_summary: string | null;
  started_at: number;
  completed_at: number | null;
  outcome: string | null;
  cost_cents: number | null;
  error_summary: string | null;
  working_memory_diff_json: string | null;
}

interface LongLivedActionRow {
  id: string;
  agent_id: string;
  tick_id: string;
  action_kind: string;
  action_target: string;
  payload_json: string;
  rationale: string | null;
  status: string;
  expires_at: number;
  decided_by: string | null;
  decided_at: number | null;
  executed_in_tick_id: string | null;
  created_at: number;
}

interface LongLivedAuditRow {
  id: number;
  agent_id: string;
  tick_id: string | null;
  pending_action_id: string | null;
  action_kind: string;
  action_target: string;
  decision: string;
  reason: string | null;
  created_at: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type ErrorCode = string;
type ErrorDetails = Record<string, unknown>;

function errorBody(code: ErrorCode, details?: ErrorDetails): { error: { code: ErrorCode } & ErrorDetails } {
  return { error: { code, ...(details ?? {}) } };
}

function errorJson(error: unknown, status = 400): Response {
  const code = error instanceof Error ? error.message : String(error);
  return json(errorBody(code), status);
}

const MANUAL_TICK_RATE_LIMIT_MS = 1_000;
const manualTickLastByDb = new WeakMap<object, Map<string, number>>();

function checkAndRecordManualTickWindow(db: object, agentId: string, nowMs: number): number | null {
  let byAgent = manualTickLastByDb.get(db);
  if (!byAgent) {
    byAgent = new Map<string, number>();
    manualTickLastByDb.set(db, byAgent);
  }
  const lastMs = byAgent.get(agentId);
  if (lastMs !== undefined) {
    const elapsedMs = nowMs - lastMs;
    if (elapsedMs < MANUAL_TICK_RATE_LIMIT_MS) return MANUAL_TICK_RATE_LIMIT_MS - elapsedMs;
  }
  byAgent.set(agentId, nowMs);
  return null;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function longLivedListRoute(_req: Request, services: Services): Promise<Response> {
  const agents = services.db.query<LongLivedAgentListRow, []>(
    `SELECT id, display_name, status, schedule_cron,
            last_tick_started_at, last_tick_completed_at, last_tick_outcome, last_intent_summary,
            consecutive_failures, circuit_breaker_threshold, retired_at,
            subscriptions_json, mcp_allowlist_json, approval_required_globs_json, cooldown_overrides_json,
            working_memory_json
     FROM long_lived_agents
     ORDER BY id`,
  ).all().map((row) => ({
    ...row,
    subscriptions: parseJson<unknown>(row.subscriptions_json ?? null),
    mcp_allowlist: parseJson<unknown>(row.mcp_allowlist_json) ?? [],
    approval_required_globs: parseJson<unknown>(row.approval_required_globs_json) ?? [],
    cooldown_overrides: parseJson<unknown>(row.cooldown_overrides_json) ?? {},
    working_memory: parseJson<unknown>(row.working_memory_json),
  }));
  return json({ agents });
}

export async function longLivedGetRoute(_req: Request, id: string, services: Services): Promise<Response> {
  const agent = services.db.query<LongLivedAgentRow, [string]>(
    `SELECT id, display_name, status, degraded_reason, consecutive_failures, circuit_breaker_threshold,
            schedule_cron, subscriptions_json, mcp_allowlist_json, approval_required_globs_json,
            cooldown_overrides_json, bounds_wall_clock_ms, bounds_cost_cents, bounds_max_sub_dispatches,
            working_memory_json, standing_brief, last_tick_started_at, last_tick_completed_at,
            last_tick_outcome, last_intent_summary, created_at, updated_at, retired_at
     FROM long_lived_agents
     WHERE id = ?
     LIMIT 1`,
  ).get(id);
  if (!agent) return json(errorBody('not_found'), 404);

  const recentTicks = services.db.query<LongLivedTickRow, [string]>(
    `SELECT id, agent_id, chain_id, trigger_kind, trigger_payload_json, intent_summary, started_at,
            completed_at, outcome, cost_cents, error_summary, working_memory_diff_json
     FROM long_lived_ticks
     WHERE agent_id = ?
     ORDER BY started_at DESC
     LIMIT 20`,
  ).all(id).map((row) => ({
    ...row,
    trigger_payload: parseJson<unknown>(row.trigger_payload_json),
    working_memory_diff: parseJson<unknown>(row.working_memory_diff_json),
  }));

  const pendingActions = services.db.query<LongLivedActionRow, [string]>(
    `SELECT id, agent_id, tick_id, action_kind, action_target, payload_json, rationale,
            status, expires_at, decided_by, decided_at, executed_in_tick_id, created_at
     FROM long_lived_pending_actions
     WHERE agent_id = ?
     ORDER BY created_at DESC`,
  ).all(id).map((row) => ({
    ...row,
    payload: parseJson<unknown>(row.payload_json),
  }));

  const recentAudit = services.db.query<LongLivedAuditRow, [string]>(
    `SELECT id, agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at
     FROM long_lived_action_audit
     WHERE agent_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 50`,
  ).all(id);

  return json({
    agent: {
      ...agent,
      subscriptions: parseJson<unknown>(agent.subscriptions_json),
      mcp_allowlist: parseJson<unknown>(agent.mcp_allowlist_json) ?? [],
      approval_required_globs: parseJson<unknown>(agent.approval_required_globs_json) ?? [],
      cooldown_overrides: parseJson<unknown>(agent.cooldown_overrides_json) ?? {},
      working_memory: parseJson<unknown>(agent.working_memory_json),
    },
    recent_ticks: recentTicks,
    pending_actions: pendingActions,
    recent_audit: recentAudit,
  });
}

export async function longLivedStreamRoute(_req: Request, _id: string, _services: Services): Promise<Response> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(': ok\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

export async function longLivedPauseRoute(_req: Request, id: string, services: Services): Promise<Response> {
  try {
    return json(await handleLongLivedPause(services.db, { id }));
  } catch (error) {
    return errorJson(error, 400);
  }
}

export async function longLivedResumeRoute(_req: Request, id: string, services: Services): Promise<Response> {
  try {
    return json(await handleLongLivedResume(services.db, { id }));
  } catch (error) {
    return errorJson(error, 400);
  }
}

export async function longLivedRetireRoute(_req: Request, id: string, services: Services): Promise<Response> {
  try {
    return json(await handleLongLivedRetire(services.db, { id }));
  } catch (error) {
    return errorJson(error, 400);
  }
}

export async function longLivedTickRoute(
  _req: Request,
  id: string,
  services: Services,
): Promise<Response> {
  try {
    const row = services.db.query<{ status: string }, [string]>(
      'SELECT status FROM long_lived_agents WHERE id = ?',
    ).get(id);
    if (!row) return json(errorBody('not_found'), 404);
    if (row.status !== 'active') return json(errorBody('not_active', { status: row.status }), 409);
    if (!services.longLivedReactor) return json(errorBody('reactor_unavailable'), 503);
    const retryAfterMs = checkAndRecordManualTickWindow(services.db, id, Date.now());
    if (retryAfterMs !== null) {
      return json(errorBody('rate_limited', { retry_after_ms: retryAfterMs }), 429);
    }
    return json(services.longLivedReactor.manualTick(id));
  } catch (error) {
    return errorJson(error, 400);
  }
}

export async function longLivedStateGetRoute(_req: Request, id: string, services: Services): Promise<Response> {
  try {
    return json(await handleLongLivedStateGet(services.db, { id }));
  } catch (error) {
    return errorJson(error, 400);
  }
}

export async function longLivedStateSetRoute(req: Request, id: string, services: Services): Promise<Response> {
  try {
    const body = await req.json() as Record<string, unknown>;
    return json(await handleLongLivedStateSet(services.db, { id, ...body }));
  } catch (error) {
    return errorJson(error, 400);
  }
}

export async function longLivedPendingActionsRoute(req: Request, id: string, services: Services): Promise<Response> {
  try {
    const url = new URL(req.url);
    return json(await handleLongLivedPendingActions(services.db, {
      id,
      status: url.searchParams.get('status'),
    }));
  } catch (error) {
    return errorJson(error, 400);
  }
}

export async function longLivedApproveActionRoute(req: Request, actionId: string, services: Services): Promise<Response> {
  try {
    const body = await req.json().catch(() => null) as { decided_by?: unknown } | null;
    const decidedBy = typeof body?.decided_by === 'string' && body.decided_by.length > 0 ? body.decided_by : 'user';
    return json(await handleLongLivedApproveAction(services.db, {
      emit: () => {},
      now: () => services.clock().getTime(),
    }, { action_id: actionId, decided_by: decidedBy }));
  } catch (error) {
    return errorJson(error, 400);
  }
}

export async function longLivedRejectActionRoute(req: Request, actionId: string, services: Services): Promise<Response> {
  try {
    const body = await req.json().catch(() => null) as { reason?: unknown; decided_by?: unknown } | null;
    const decidedBy = typeof body?.decided_by === 'string' && body.decided_by.length > 0 ? body.decided_by : 'user';
    return json(await handleLongLivedRejectAction(services.db, {
      emit: () => {},
      now: () => services.clock().getTime(),
    }, {
      action_id: actionId,
      reason: typeof body?.reason === 'string' && body.reason.length > 0 ? body.reason : undefined,
      decided_by: decidedBy,
    }));
  } catch (error) {
    return errorJson(error, 400);
  }
}

export async function longLivedInjectGoalRoute(req: Request, id: string, services: Services): Promise<Response> {
  try {
    const body = await req.json() as Record<string, unknown>;
    return json(await handleLongLivedInjectGoal(services.db, {
      fireTick: () => {},
      now: () => services.clock().getTime(),
    }, { id, goal: String(body.goal ?? '') }));
  } catch (error) {
    return errorJson(error, 400);
  }
}

export async function longLivedAuditRoute(req: Request, id: string, services: Services): Promise<Response> {
  try {
    const url = new URL(req.url);
    const since = url.searchParams.get('since');
    const limit = url.searchParams.get('limit');
    return json(await handleLongLivedAudit(services.db, {
      id,
      since: since === null ? undefined : Number(since),
      limit: limit === null ? undefined : Number(limit),
    }));
  } catch (error) {
    return errorJson(error, 400);
  }
}

export async function longLivedTicksRoute(req: Request, id: string, services: Services): Promise<Response> {
  try {
    const url = new URL(req.url);
    const since = url.searchParams.get('since');
    const limit = url.searchParams.get('limit');
    return json(await handleLongLivedTicks(services.db, {
      id,
      since: since === null ? undefined : Number(since),
      limit: limit === null ? undefined : Number(limit),
    }));
  } catch (error) {
    return errorJson(error, 400);
  }
}
