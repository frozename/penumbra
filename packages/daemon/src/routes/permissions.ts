import type { Services } from '@penumbra/core';
import { CreatePermissionRequestSchema } from '@penumbra/core';

const DEFAULT_TTL_SECONDS = 300;

async function safeJson(req: Request): Promise<unknown | null> {
  try { return await req.json(); } catch { return null; }
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function permissionsCreateRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);

  const parsed = CreatePermissionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    }, 400);
  }

  const ttl_seconds = parsed.data.ttl_seconds
    ?? Number((services.settings as any)?.permission_ttl_seconds ?? DEFAULT_TTL_SECONDS);
  const now = services.clock();

  const row = services.permissionWriter.create({
    permission_id: parsed.data.permission_id,
    parent_handoff_id: parsed.data.parent_handoff_id,
    conversation_id: parsed.data.conversation_id,
    agent_name: parsed.data.agent_name,
    tool_name: parsed.data.tool_name,
    raw_input: parsed.data.raw_input,
    ttl_seconds,
    now,
  });

  // Audit + bus emission only when this call genuinely created the row
  // (idempotent re-POST returns the existing row unchanged — no event fanned out).
  const isFreshCreate = row.created_at === now.toISOString();
  if (isFreshCreate) {
    services.permissionEvents.emit({
      kind: 'permission.created',
      permission_id: row.permission_id,
      ts: row.created_at,
      payload: {
        permission_id: row.permission_id,
        parent_handoff_id: row.parent_handoff_id,
        conversation_id: row.conversation_id,
        agent_name: row.agent_name,
        tool_name: row.tool_name,
        ttl_at: row.ttl_at,
        created_at: row.created_at,
      },
    });
    services.t0Writer.write({
      event_id: services.uuid(),
      ts: row.created_at,
      ingest_ts: row.created_at,
      source: 'mcp',
      source_detail: 'permission-audit',
      project_id: null,
      user_id: services.machineId.get(),
      machine_id: services.machineId.get(),
      session_id: row.conversation_id,
      event_type: 'permission-requested',
      lane: 'unknown',
      provider: null, model: null,
      tokens_in: null, tokens_out: null, cost_usd: null, latency_ms: null,
      request_id: null,
      payload_json: {
        permission_id: row.permission_id,
        parent_handoff_id: row.parent_handoff_id,
        agent_name: row.agent_name,
        tool_name: row.tool_name,
        raw_input: JSON.parse(row.raw_input_json),
      },
      payload_summary: `${row.agent_name} requested ${row.tool_name}`,
    });
  }

  return json({
    permission_id: row.permission_id,
    status: row.status,
    ttl_at: row.ttl_at,
  });
}
