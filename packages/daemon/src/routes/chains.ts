import type { Services } from '@penumbra/core';
import { ChainStartRequestSchema } from '@penumbra/core';

export async function chainsStartRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);

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

async function safeJson(req: Request): Promise<unknown | null> {
  try { return await req.json(); } catch { return null; }
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}