import { z } from 'zod';
import type { Services } from '@penumbra/core';
import {
  CreateHandoffRequestSchema,
  ApproveHandoffRequestSchema,
  HandoffStatusSchema,
  classifyDispatchReliability,
} from '@penumbra/core';
import { handleTickTeardown, type TickOutcome } from '../long-lived/teardown.js';
import { resolveSingleRoute } from './role-routing.js';

// Read the snapshot the worker captured at dispatch.end. See dispatcher.ts
// getWorktreeSnapshot — we avoid live git probes because post-merge they
// can no longer distinguish "agent did nothing" from "agent committed and
// main moved forward to the same SHA".
import { json } from './_helpers.js';
function readWorktreeChangedSnapshot(events: Array<{ kind: string; meta: unknown }>): boolean | null {
  const dispatchEnd = events.filter((e) => e.kind === 'dispatch.end').at(-1);
  const meta = dispatchEnd?.meta;
  if (meta && typeof meta === 'object' && 'worktree_changed' in meta) {
    const v = (meta as Record<string, unknown>).worktree_changed;
    if (typeof v === 'boolean') return v;
  }
  return null;
}

function readDispatchEndCommittedFromEvents(events: Array<{ kind: string; meta: unknown }>): boolean | null {
  const dispatchEnd = events.filter((e) => e.kind === 'dispatch.end').at(-1);
  const meta = dispatchEnd?.meta;
  if (meta && typeof meta === 'object' && 'committed' in meta) {
    const v = (meta as Record<string, unknown>).committed;
    if (typeof v === 'boolean') return v;
  }
  return null;
}

const VALID_STATUSES = new Set<string>(HandoffStatusSchema.options);

interface LongLivedTickRow {
  id: string;
  agent_id: string;
  chain_id: string | null;
  completed_at: number | null;
  outcome: string | null;
}

interface AgentPerformanceCostRow {
  cost_usd: number | null;
}

function maybeTeardownLongLivedTick(params: {
  services: Services;
  handoff_id: string;
  dispatch_kind: string | null | undefined;
  long_lived_tick_id: string | null | undefined;
  outcome: TickOutcome;
  error?: string;
  resolved_at_iso: string;
}): void {
  if (params.dispatch_kind !== 'long_lived_tick') return;
  if (!params.long_lived_tick_id) return;

  try {
    const tick = params.services.db.query<LongLivedTickRow, [string]>(
      'SELECT id, agent_id, chain_id, completed_at, outcome FROM long_lived_ticks WHERE id = ?',
    ).get(params.long_lived_tick_id);
    if (!tick) return;
    if (tick.completed_at !== null || tick.outcome !== null) return;

    const resolvedAtMs = Date.parse(params.resolved_at_iso);
    const costRows = tick.chain_id
      ? params.services.db.query<AgentPerformanceCostRow, [string]>(
          `SELECT cost_usd
             FROM agent_performance
            WHERE conversation_id = ?
              AND source <> 'manual_seed'
              AND cost_usd IS NOT NULL`,
        ).all(tick.chain_id)
      : [];
    const totalCostUsd = costRows.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0);
    const cost_cents = costRows.length > 0 ? Math.round(totalCostUsd * 100) : null;
    if (cost_cents === null) {
      params.services.log.warn(
        { handoff_id: params.handoff_id, long_lived_tick_id: params.long_lived_tick_id },
        'long-lived tick teardown could not stamp cost_cents yet',
      );
    }
    handleTickTeardown(params.services.db, {
      tick_id: tick.id,
      agent_id: tick.agent_id,
      outcome: params.outcome,
      error: params.error,
      now: Number.isNaN(resolvedAtMs) ? Date.now() : resolvedAtMs,
      cost_cents: cost_cents ?? undefined,
    });
  } catch (err) {
    params.services.log.warn(
      {
        handoff_id: params.handoff_id,
        long_lived_tick_id: params.long_lived_tick_id,
        err: err instanceof Error ? err.message : String(err),
      },
      'long-lived tick teardown failed during terminal handoff transition',
    );
  }
}

export async function handoffsCreateRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);

  const parsed = CreateHandoffRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    }, 400);
  }

  const handoff_id = services.uuid();
  const ts = services.clock().toISOString();
  const route = parsed.data.to_role
    ? resolveSingleRoute(
        services,
        parsed.data.to_role,
        parsed.data.message,
        parsed.data.chain_task_type ?? undefined,
      )
    : null;
  const routedAgent = route?.agent ?? parsed.data.to;
  const routedRole = route?.role ?? parsed.data.to_role ?? null;
  const routingTaskType = route?.taskType ?? parsed.data.chain_task_type ?? null;

  // Single transaction: write t0 'agent-handoff' event AND the handoffs row.
  services.db.transaction(() => {
    services.t0Writer.write({
      event_id: handoff_id,
      ts,
      ingest_ts: ts,
      source: 'mcp',
      source_detail: 'agent-handoff',
      project_id: parsed.data.project_id ?? null,
      user_id: parsed.data.from,
      machine_id: services.machineId.get(),
      session_id: parsed.data.conversation_id,
      event_type: 'agent-handoff',
      lane: 'unknown',
      provider: null, model: null,
      tokens_in: null, tokens_out: null, cost_usd: null, latency_ms: null,
      request_id: null,
      origin: null,
      payload_json: {
        from: parsed.data.from,
        to: routedAgent,
        mentioned_as: routedRole ? 'role' : 'name',
        routed_role: routedRole,
        message_excerpt: parsed.data.message.slice(0, 240),
        triggered_by_event_id: parsed.data.triggered_by_event_id,
      },
      payload_summary: parsed.data.message.slice(0, 240),
    });

    services.handoffWriter.create({
      handoff_id, ts,
      from: parsed.data.from,
      to: routedAgent,
      to_role: routedRole,
      message: parsed.data.message,
      conversation_id: parsed.data.conversation_id,
      project_id: parsed.data.project_id ?? null,
      triggered_by_event_id: parsed.data.triggered_by_event_id,
      use_worktree: parsed.data.use_worktree ?? undefined,
      chain_task_type: routingTaskType,
    });
  })();

  return json({
    handoff_id,
    status: 'pending',
    ...(route ? {
      routed_agent: route.agent,
      routed_role: route.role,
      routing_task_type: route.taskType,
    } : {}),
  });
}

async function safeJson(req: Request): Promise<unknown | null> {
  try { return await req.json(); } catch { return null; }
}

export async function handoffsListPendingRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const conv = url.searchParams.get('conversation_id') ?? undefined;
  const statusParam = url.searchParams.get('status');
  const sinceParam = url.searchParams.get('since');

  if (statusParam !== null) {
    const statuses = statusParam.split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length === 0) return json({ error: { code: 'validation_error', message: 'status is empty' } }, 400);
    for (const s of statuses) {
      if (!VALID_STATUSES.has(s as any)) {
        return json({ error: { code: 'validation_error', message: `unknown status: ${s}` } }, 400);
      }
    }
    if (statuses.length === 1 && statuses[0] === 'completed' && sinceParam !== null) {
      if (!sinceParam || Number.isNaN(Date.parse(sinceParam))) {
        return json({ error: { code: 'validation_error', message: 'since must be an ISO timestamp' } }, 400);
      }
      const sinceUtc = new Date(sinceParam).toISOString();
      const done = services.handoffReader.countCompletedSince({
        since: sinceUtc,
        conversation_id: conv,
      });
      return json({ done });
    }
    const handoffs = services.handoffReader.listByStatus({
      statuses: statuses as any,
      conversation_id: conv,
    });
    return json({ handoffs });
  }

  // No status param: back-compat — pending only
  const handoffs = services.handoffReader.listPending(conv ? { conversation_id: conv } : undefined);
  return json({ handoffs });
}

export async function handoffsLatestRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const conversation_id = url.searchParams.get('conversation_id');
  if (!conversation_id) {
    return json({ error: { code: 'missing_param', message: 'conversation_id query parameter is required' } }, 400);
  }
  const handoff = services.handoffReader.getLatestForConversation(conversation_id);
  if (!handoff) {
    return json({ error: { code: 'not_found', message: 'no handoffs found for conversation' } }, 404);
  }
  return json({ handoff });
}

export async function handoffsApproveRoute(req: Request, handoff_id: string, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);
  const parsed = ApproveHandoffRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json({
      error: { code: 'validation_error', field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
    }, 400);
  }
  const ts = services.clock().toISOString();
  try {
    if (parsed.data.reject) {
      services.handoffWriter.reject(handoff_id, { resolved_by: parsed.data.resolved_by ?? services.machineId.get(), resolved_at: ts, reason: parsed.data.reason });
      const rejected = services.handoffReader.get(handoff_id);
      if (rejected) {
        maybeTeardownLongLivedTick({
          services,
          handoff_id,
          dispatch_kind: rejected.dispatch_kind,
          long_lived_tick_id: rejected.long_lived_tick_id,
          outcome: 'failed',
          error: parsed.data.reason ?? 'rejected',
          resolved_at_iso: ts,
        });
      }
      return json({ handoff_id, status: 'rejected' });
    }
    const result = services.handoffWriter.approve(handoff_id, {
      resolved_by: parsed.data.resolved_by ?? services.machineId.get(),
      resolved_at: ts,
      redirect_to: parsed.data.redirect_to,
    });
    return json({ handoff_id, status: result.status, redirected_to: result.redirected_to });
  } catch (err) {
    const cur = services.handoffReader.get(handoff_id);
    if (!cur) return json({ error: { code: 'not_found', message: `handoff ${handoff_id} does not exist` } }, 404);
    return json({ error: { code: 'conflict', message: `handoff ${handoff_id} is ${cur.status}, not pending` }, current_status: cur.status }, 409);
  }
}

export async function handoffsClaimRoute(req: Request, handoff_id: string, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);

  const body = z.object({ worker_id: z.string().min(1) }).safeParse(raw);
  if (!body.success) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: body.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    }, 400);
  }

  const cur = services.handoffReader.get(handoff_id);
  if (!cur) return json({ error: { code: 'not_found', message: `handoff ${handoff_id} does not exist` } }, 404);
  const won = services.handoffWriter.claimDispatch(handoff_id, body.data.worker_id);
  if (!won) {
    const after = services.handoffReader.get(handoff_id);
    return json({
      error: { code: 'conflict', message: `handoff ${handoff_id} cannot be claimed (status=${after?.status ?? 'unknown'})` },
      current_status: after?.status ?? null,
    }, 409);
  }

  const claimedRoot = services.db.query<{ root_handoff_id: string | null }, [string]>(
    `SELECT root_handoff_id FROM handoffs WHERE handoff_id = ?`,
  ).get(handoff_id);
  if (claimedRoot) {
    const perRootTop3 = services.db.query<{ root_handoff_id: string; in_flight_count: number }, []>(
      `SELECT root_handoff_id, COUNT(*) AS in_flight_count
       FROM handoffs
       WHERE status='dispatched'
       GROUP BY root_handoff_id
       ORDER BY in_flight_count DESC, root_handoff_id ASC
       LIMIT 3`,
    ).all();
    services.dispatchEventLog.record({
      handoff_id,
      worker_id: body.data.worker_id,
      source: 'daemon',
      kind: 'claim' as any,
      ts: services.clock().toISOString(),
      meta: {
        root_handoff_id: claimedRoot.root_handoff_id ?? handoff_id,
        per_root_top3: perRootTop3,
      },
    });
  }
  return json({ handoff_id, status: 'dispatched' });
}

export async function handoffsCompleteRoute(_req: Request, handoff_id: string, services: Services): Promise<Response> {
  // Atomic: try the dispatched→completed transition first, then explain the failure if it didn't happen.
  const completedAtIso = services.clock().toISOString();
  const won = services.handoffWriter.markCompleted(handoff_id, { ts: completedAtIso });
  if (won) {
    const completed = services.handoffReader.get(handoff_id);
    if (completed) {
      maybeTeardownLongLivedTick({
        services,
        handoff_id,
        dispatch_kind: completed.dispatch_kind,
        long_lived_tick_id: completed.long_lived_tick_id,
        outcome: 'success',
        resolved_at_iso: completedAtIso,
      });
    }
    return json({ handoff_id, status: 'completed' });
  }
  const cur = services.handoffReader.get(handoff_id);
  if (!cur) return json({ error: { code: 'not_found', message: `handoff ${handoff_id} does not exist` } }, 404);
  if (cur.status === 'dispatched' && cur.cancel_requested_at !== null) {
    const cancelledAtIso = services.clock().toISOString();
    services.handoffWriter.markFailed(handoff_id, {
      reason: 'cancelled',
      resolved_by: 'cancel',
      ts: cancelledAtIso,
    });
    const cancelled = services.handoffReader.get(handoff_id);
    if (cancelled) {
      maybeTeardownLongLivedTick({
        services,
        handoff_id,
        dispatch_kind: cancelled.dispatch_kind,
        long_lived_tick_id: cancelled.long_lived_tick_id,
        outcome: 'failed',
        error: 'cancelled',
        resolved_at_iso: cancelledAtIso,
      });
    }
    return json({ handoff_id, status: 'failed', reason: 'cancelled' });
  }
  return json({
    error: { code: 'conflict', message: `handoff ${handoff_id} is ${cur.status}, not dispatched` },
    current_status: cur.status,
  }, 409);
}

export async function handoffsGetRoute(_req: Request, handoff_id: string, services: Services): Promise<Response> {
  const handoff = services.handoffReader.get(handoff_id);
  if (!handoff) {
    return json({ error: { code: 'not_found', message: `handoff ${handoff_id} not found` } }, 404);
  }
  return json({ handoff });
}

export async function handoffsStatusRoute(_req: Request, handoff_id: string, services: Services): Promise<Response> {
  const row = services.handoffReader.get(handoff_id);
  if (!row) {
    return json({ error: { code: 'not_found', message: `handoff not found: ${handoff_id}` } }, 404);
  }

  const started_at = row.ts;
  const terminal = row.status === 'completed' || row.status === 'failed' || row.status === 'rejected' || row.status === 'expired';
  const resolved_at = terminal ? (row.resolved_at ?? null) : null;
  const latency_seconds = resolved_at && started_at
    ? Math.round((new Date(resolved_at).getTime() - new Date(started_at).getTime()) / 1000)
    : null;
  const error_summary = row.status === 'failed' && row.resolution_reason
    ? (row.resolution_reason.split('\n')[0]?.slice(0, 200) ?? null)
    : null;
  const events = services.dispatchEventLog.listByHandoff(handoff_id).map((event) => ({
    kind: event.kind,
    ts: event.ts,
    meta: parseMeta(event.meta_json),
  }));
  const responses = services.chainReader.getResponses(row.conversation_id, 'final');
  const worktreeChanged = readWorktreeChangedSnapshot(events);
  const dispatchEndCommitted = readDispatchEndCommittedFromEvents(events);
  const reliability = classifyDispatchReliability({
    handoff: {
      handoff_id: row.handoff_id,
      status: row.status,
      ts: row.ts,
      resolved_at: row.resolved_at,
      cancel_requested_at: row.cancel_requested_at,
      chain_task_type: row.chain_task_type,
      use_worktree: row.use_worktree,
    },
    events,
    responseCount: responses.length,
    finalResponseText: responses.at(-1)?.text ?? null,
    worktreeChanged,
    dispatchEndCommitted,
    reconciled: null,
    adapterStreaming: null,
    now: services.clock(),
  });

  return json({
    handoff_id,
    status: row.status,
    error_summary,
    worker_id: row.worker_id ?? null,
    started_at,
    resolved_at,
    latency_seconds,
    reliability: {
      status: reliability.status,
      trustworthy: reliability.trustworthy,
      recommended_action: reliability.recommended_action,
      summary: reliability.summary,
    },
  });
}

function parseMeta(metaJson: string | null): unknown {
  if (!metaJson) return null;
  try {
    return JSON.parse(metaJson);
  } catch {
    return null;
  }
}

export async function handoffsFailRoute(req: Request, handoff_id: string, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);

  const body = z.object({ reason: z.string().min(1) }).safeParse(raw);
  if (!body.success) {
    return json({
      error: { code: 'validation_error', message: 'body failed schema validation', field_errors: body.error.issues.map((i) => ({ path: i.path, message: i.message })) },
    }, 400);
  }

  const ts = services.clock().toISOString();
  const won = services.handoffWriter.markFailed(handoff_id, {
    reason: body.data.reason,
    ts,
    resolved_by: services.machineId.get(),
  });

  if (won) {
    const failed = services.handoffReader.get(handoff_id);
    if (failed) {
      maybeTeardownLongLivedTick({
        services,
        handoff_id,
        dispatch_kind: failed.dispatch_kind,
        long_lived_tick_id: failed.long_lived_tick_id,
        outcome: 'failed',
        error: body.data.reason,
        resolved_at_iso: ts,
      });
    }
    return json({ handoff_id, status: 'failed' });
  }

  const cur = services.handoffReader.get(handoff_id);
  if (!cur) return json({ error: { code: 'not_found', message: `handoff ${handoff_id} does not exist` } }, 404);
  return json({
    error: { code: 'conflict', message: `handoff ${handoff_id} is ${cur.status}, cannot be failed` },
    current_status: cur.status,
  }, 409);
}
