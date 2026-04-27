import type { Services } from '@penumbra/core';
import { ChainStartRequestSchema } from '@penumbra/core';

export async function chainsStartRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);

  // P0.4: Check for active worker heartbeats (default 30s timeout)
  const timeoutMsStr = process.env.PENUMBRA_WORKER_HEARTBEAT_TIMEOUT_MS;
  const timeoutMs = timeoutMsStr ? parseInt(timeoutMsStr, 10) : 30000;
  if (!services.watchdog.hasActiveWorker(timeoutMs)) {
    return json(
      {
        error: {
          code: 'no_worker_registered',
          message: "no agentchat-worker registered; start one via 'bun packages/agentchat/bin/agentchat-worker.ts --storage-root <root>'",
        },
      },
      503,
    );
  }

  const parsed = ChainStartRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    }, 400);
  }

  const conversation_id = parsed.data.conversation_id ?? `conv-${services.uuid()}`;
  const user_prompt_event_id = services.uuid();
  const handoff_id = services.uuid();
  const ts = services.clock().toISOString();

  services.db.transaction(() => {
    services.t0Writer.write({
      event_id: user_prompt_event_id,
      ts, ingest_ts: ts,
      source: 'agentchat',
      source_detail: 'chain-start',
      project_id: parsed.data.project_id ?? null,
      user_id: 'local-user',
      machine_id: services.machineId.get(),
      session_id: conversation_id,
      event_type: 'user-prompt',
      lane: 'cli-subscription',
      provider: null, model: null,
      tokens_in: null, tokens_out: null, cost_usd: null, latency_ms: null,
      request_id: null,
      payload_json: { prompt: parsed.data.message },
      payload_summary: parsed.data.message.slice(0, 240),
    });

    services.handoffWriter.createApproved({
      handoff_id, ts,
      project_id: parsed.data.project_id ?? null,
      conversation_id,
      from: 'user',
      to: parsed.data.initial_agent,
      to_role: null,
      message: parsed.data.message,
      triggered_by_event_id: user_prompt_event_id,
      resolved_by: 'chain-start',
      resolved_at: ts,
      chain_max_hops: parsed.data.max_hops ?? null,
      chain_trust_mode: parsed.data.trust_mode ?? null,
    });
  })();

  return json({ conversation_id, handoff_id });
}

export async function chainsHistoryRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const conversation_id = url.searchParams.get('conversation_id');
  if (!conversation_id) {
    return json({ error: { code: 'missing_param', message: 'conversation_id query parameter is required' } }, 400);
  }
  const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
  const history = services.chainReader.listHistory(conversation_id, limit);
  return json({ history });
}

export async function chainsResponsesRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const conversation_id = url.searchParams.get('conversation_id');
  if (!conversation_id) {
    return json({ error: { code: 'missing_param', message: 'conversation_id query parameter is required' } }, 400);
  }
  const whichParam = url.searchParams.get('which');
  const which = whichParam === 'all' ? 'all' : 'final';
  const responses = services.chainReader.getResponses(conversation_id, which);
  if (responses.length === 0 && !services.chainReader.conversationExists(conversation_id)) {
    return json({ error: { code: 'not_found', message: 'no chain events found for conversation' } }, 404);
  }
  return json({ responses });
}

async function safeJson(req: Request): Promise<unknown | null> {
  try { return await req.json(); } catch { return null; }
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
