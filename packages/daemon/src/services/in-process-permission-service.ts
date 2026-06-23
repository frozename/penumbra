import type { Services } from "@penumbra/core";

const DEFAULT_TTL_SECONDS = 300;

export interface InProcessPermissionRequestInput {
  parent_handoff_id: string;
  agent_name: string;
  tool_name: string;
  context: Record<string, unknown>;
  ttl_seconds?: number;
}

export interface InProcessPermissionDecision {
  approved: boolean;
  reason: string | null;
}

/**
 * In-process equivalent of the worker's PermissionDaemonClient for daemon-side
 * callers (currently the shell route). The HTTP /permissions/* surface stays
 * the canonical entry point for workers; this shim lets routes that already
 * run inside the daemon raise a permission request without an HTTP loopback.
 *
 * Decision delivery comes from `services.permissionEvents`. The TTL sweeper
 * (sweepers/permission-ttl.ts) emits `permission.expired` and reaps the row.
 */
export class InProcessPermissionService {
  private waiters = new Map<
    string,
    {
      resolve: (d: InProcessPermissionDecision) => void;
      reject: (e: Error) => void;
    }
  >();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly services: Services) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.services.permissionEvents.subscribe((evt) => {
      const w = this.waiters.get(evt.permission_id);
      if (!w) return;
      if (evt.kind === "permission.decided") {
        this.waiters.delete(evt.permission_id);
        const payload = evt.payload as { decision?: string; reason?: string | null };
        w.resolve({
          approved: payload.decision === "approve",
          reason: payload.reason ?? null,
        });
      } else if (evt.kind === "permission.expired") {
        this.waiters.delete(evt.permission_id);
        w.reject(new Error(`permission ${evt.permission_id} expired`));
      }
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const w of this.waiters.values()) {
      w.reject(new Error("InProcessPermissionService stopped"));
    }
    this.waiters.clear();
  }

  async requestPermission(
    input: InProcessPermissionRequestInput,
  ): Promise<InProcessPermissionDecision> {
    if (!this.unsubscribe) throw new Error("InProcessPermissionService not started");

    const handoff = this.services.handoffReader.get(input.parent_handoff_id);
    const conversation_id = handoff?.conversation_id ?? input.parent_handoff_id;
    const permission_id = this.services.uuid();
    const ttl_seconds = input.ttl_seconds ?? DEFAULT_TTL_SECONDS;

    // Register the waiter BEFORE create() so an instant decision via the bus
    // can't slip past us.
    const promise = new Promise<InProcessPermissionDecision>((resolve, reject) => {
      this.waiters.set(permission_id, { resolve, reject });
    });

    let row: Awaited<ReturnType<typeof this.services.permissionWriter.create>>["row"];
    let created: boolean;
    try {
      const result = this.services.permissionWriter.create({
        permission_id,
        parent_handoff_id: input.parent_handoff_id,
        conversation_id,
        agent_name: input.agent_name,
        tool_name: input.tool_name,
        raw_input: input.context,
        ttl_seconds,
        now: this.services.clock(),
      });
      row = result.row;
      created = result.created;
    } catch (err) {
      this.waiters.delete(permission_id);
      throw err;
    }

    if (created) {
      this.services.permissionEvents.emit({
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
      this.services.t0Writer.write({
        event_id: this.services.uuid(),
        ts: row.created_at,
        ingest_ts: row.created_at,
        source: "mcp",
        source_detail: "permission-audit",
        project_id: null,
        user_id: this.services.machineId.get(),
        machine_id: this.services.machineId.get(),
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

    if (row.status !== "pending") {
      this.waiters.delete(permission_id);
      if (row.status === "approved" || row.status === "rejected") {
        return { approved: row.status === "approved", reason: row.decision_reason ?? null };
      }
      throw new Error(`permission ${permission_id} expired`);
    }

    return await promise;
  }
}
