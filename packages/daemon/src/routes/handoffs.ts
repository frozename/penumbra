import { z } from 'zod';
import type { Services } from '@penumbra/core';
import { CreateHandoffRequestSchema, ApproveHandoffRequestSchema, HandoffStatusSchema } from '@penumbra/core';

const VALID_STATUSES = new Set<string>(HandoffStatusSchema.options);

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
      payload_json: {
        from: parsed.data.from,
        to: parsed.data.to,
        mentioned_as: parsed.data.to_role ? 'role' : 'name',
        message_excerpt: parsed.data.message.slice(0, 240),
        triggered_by_event_id: parsed.data.triggered_by_event_id,
      },
      payload_summary: parsed.data.message.slice(0, 240),
    });

    services.handoffWriter.create({
      handoff_id, ts,
      from: parsed.data.from,
      to: parsed.data.to,
      to_role: parsed.data.to_role ?? null,
      message: parsed.data.message,
      conversation_id: parsed.data.conversation_id,
      project_id: parsed.data.project_id ?? null,
      triggered_by_event_id: parsed.data.triggered_by_event_id,
      use_worktree: parsed.data.use_worktree ?? undefined,
    });
  })();

  return json({ handoff_id, status: 'pending' });
}

async function safeJson(req: Request): Promise<unknown | null> {
  try { return await req.json(); } catch { return null; }
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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
      const done = services.handoffReader.countCompletedSince({
        since: sinceParam,
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
  return json({ handoff_id, status: 'dispatched' });
}

export async function handoffsCompleteRoute(_req: Request, handoff_id: string, services: Services): Promise<Response> {
  // Atomic: try the dispatched→completed transition first, then explain the failure if it didn't happen.
  const won = services.handoffWriter.markCompleted(handoff_id, { ts: services.clock().toISOString() });
  if (won) return json({ handoff_id, status: 'completed' });
  const cur = services.handoffReader.get(handoff_id);
  if (!cur) return json({ error: { code: 'not_found', message: `handoff ${handoff_id} does not exist` } }, 404);
  if (cur.status === 'dispatched' && cur.cancel_requested_at !== null) {
    services.handoffWriter.markFailed(handoff_id, {
      reason: 'cancelled',
      resolved_by: 'cancel',
      ts: services.clock().toISOString(),
    });
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

  return json({
    handoff_id,
    status: row.status,
    error_summary,
    worker_id: row.worker_id ?? null,
    started_at,
    resolved_at,
    latency_seconds,
  });
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

  if (won) return json({ handoff_id, status: 'failed' });

  const cur = services.handoffReader.get(handoff_id);
  if (!cur) return json({ error: { code: 'not_found', message: `handoff ${handoff_id} does not exist` } }, 404);
  return json({
    error: { code: 'conflict', message: `handoff ${handoff_id} is ${cur.status}, cannot be failed` },
    current_status: cur.status,
  }, 409);
}
