import type { Services } from "@penumbra/core";
import { CreatePermissionRequestSchema, ApprovePermissionRequestSchema } from "@penumbra/core";

import { json } from "./_helpers.js";
const DEFAULT_TTL_SECONDS = 300;

async function safeJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export async function permissionsCreateRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null)
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );

  const parsed = CreatePermissionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        error: {
          code: "validation_error",
          message: "body failed schema validation",
          field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
      },
      400,
    );
  }

  const ttl_seconds =
    parsed.data.ttl_seconds ??
    Number((services.settings as any)?.permission_ttl_seconds ?? DEFAULT_TTL_SECONDS);
  const now = services.clock();

  const { row, created: isFreshCreate } = services.permissionWriter.create({
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
  if (isFreshCreate) {
    services.permissionEvents.emit({
      kind: "permission.created",
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
      source: "mcp",
      source_detail: "permission-audit",
      project_id: null,
      user_id: services.machineId.get(),
      machine_id: services.machineId.get(),
      session_id: row.conversation_id,
      event_type: "permission-requested",
      lane: "unknown",
      provider: null,
      model: null,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      latency_ms: null,
      request_id: null,
      origin: null,
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

import { PermissionStatusSchema } from "@penumbra/core";

const VALID_STATUSES = new Set<string>(PermissionStatusSchema.options);

export async function permissionsGetRoute(
  _req: Request,
  permission_id: string,
  services: Services,
): Promise<Response> {
  const row = services.permissionReader.get(permission_id);
  if (!row) {
    return json(
      { error: { code: "not_found", message: `permission ${permission_id} not found` } },
      404,
    );
  }
  return json({ permission: row });
}

export async function permissionsListRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const conv = url.searchParams.get("conversation_id") ?? undefined;
  const parent = url.searchParams.get("parent_handoff_id") ?? undefined;
  const statusParam = url.searchParams.get("status");

  let statuses: string[];
  if (statusParam !== null) {
    statuses = statusParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (statuses.length === 0) {
      return json({ error: { code: "validation_error", message: "status is empty" } }, 400);
    }
    for (const s of statuses) {
      if (!VALID_STATUSES.has(s)) {
        return json({ error: { code: "validation_error", message: `unknown status: ${s}` } }, 400);
      }
    }
  } else {
    statuses = ["pending"];
  }

  const permissions = services.permissionReader.listByStatus({
    statuses: statuses as any,
    conversation_id: conv,
    parent_handoff_id: parent,
  });
  return json({ permissions });
}

export async function permissionsDecideRoute(
  req: Request,
  permission_id: string,
  services: Services,
): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null)
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );

  const parsed = ApprovePermissionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        error: {
          code: "validation_error",
          message: "body failed schema validation",
          field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
      },
      400,
    );
  }

  const decided_at = services.clock().toISOString();
  const decided_by = parsed.data.resolved_by ?? services.machineId.get();

  const row = services.permissionWriter.decide(permission_id, {
    decision: parsed.data.decision,
    remember: parsed.data.remember,
    decided_by,
    decided_at,
    reason: parsed.data.reason ?? null,
  });

  if (!row) {
    const cur = services.permissionReader.get(permission_id);
    if (!cur) {
      return json(
        { error: { code: "not_found", message: `permission ${permission_id} does not exist` } },
        404,
      );
    }
    return json(
      {
        error: {
          code: "conflict",
          message: `permission ${permission_id} is ${cur.status}, not pending`,
        },
        current_status: cur.status,
      },
      409,
    );
  }

  services.permissionEvents.emit({
    kind: "permission.decided",
    permission_id: row.permission_id,
    ts: decided_at,
    payload: {
      permission_id: row.permission_id,
      parent_handoff_id: row.parent_handoff_id,
      conversation_id: row.conversation_id,
      agent_name: row.agent_name,
      tool_name: row.tool_name,
      decision: parsed.data.decision,
      remember: parsed.data.remember ?? null,
      decided_by,
      decided_at,
      reason: parsed.data.reason ?? null,
    },
  });

  services.t0Writer.write({
    event_id: services.uuid(),
    ts: decided_at,
    ingest_ts: decided_at,
    source: "mcp",
    source_detail: "permission-audit",
    project_id: null,
    user_id: services.machineId.get(),
    machine_id: services.machineId.get(),
    session_id: row.conversation_id,
    event_type: "permission-decided",
    lane: "unknown",
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    origin: null,
    payload_json: {
      permission_id: row.permission_id,
      tool_name: row.tool_name,
      decision: parsed.data.decision,
      remember: parsed.data.remember ?? null,
      decided_by,
      reason: parsed.data.reason ?? null,
    },
    payload_summary: `${parsed.data.decision} ${row.tool_name}`,
  });

  return json({
    permission_id: row.permission_id,
    status: row.status,
    decided_at,
  });
}
