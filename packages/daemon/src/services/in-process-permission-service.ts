import type { Services } from "@penumbra/core";

const DEFAULT_TTL_SECONDS = 300;

export interface InProcessPermissionRequestInput {
  parent_handoff_id: string;
  agent_name: string;
  tool_name: string;
  context: Record<string, unknown>;
  ttl_seconds?: number;
  signal?: AbortSignal;
}

export interface InProcessPermissionDecision {
  approved: boolean;
  reason: string | null;
}

interface PermissionWaiter {
  resolve: (decision: InProcessPermissionDecision) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

function permissionAbortError(): Error {
  const error = new Error("permission request aborted");
  error.name = "AbortError";
  return error;
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
  private waiters = new Map<string, PermissionWaiter>();
  private abortedPermissions = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly services: Services) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.services.permissionEvents.subscribe((evt) => {
      if (evt.kind !== "permission.decided" && evt.kind !== "permission.expired") return;
      const w = this.takeWaiter(evt.permission_id);
      if (!w) return;
      if (evt.kind === "permission.decided") {
        const payload = evt.payload as { decision?: string; reason?: string | null };
        w.resolve({
          approved: payload.decision === "approve",
          reason: payload.reason ?? null,
        });
      } else {
        w.reject(new Error(`permission ${evt.permission_id} expired`));
      }
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const w of this.waiters.values()) {
      w.cleanup();
      w.reject(new Error("InProcessPermissionService stopped"));
    }
    this.waiters.clear();
    this.abortedPermissions.clear();
  }

  isPermissionAborted(permissionId: string): boolean {
    return this.abortedPermissions.has(permissionId);
  }

  async requestPermission(
    input: InProcessPermissionRequestInput,
  ): Promise<InProcessPermissionDecision> {
    if (!this.unsubscribe) throw new Error("InProcessPermissionService not started");
    if (input.signal?.aborted) throw permissionAbortError();

    const handoff = this.services.handoffReader.get(input.parent_handoff_id);
    const conversation_id = handoff?.conversation_id ?? input.parent_handoff_id;
    const permission_id = this.services.uuid();
    const ttl_seconds = input.ttl_seconds ?? DEFAULT_TTL_SECONDS;

    // Register the waiter BEFORE create() so an instant decision via the bus
    // can't slip past us.
    let removeAbortListener = (): void => undefined;
    const promise = new Promise<InProcessPermissionDecision>((resolve, reject) => {
      this.waiters.set(permission_id, {
        resolve,
        reject,
        cleanup: () => {
          removeAbortListener();
        },
      });
    });
    if (input.signal) {
      const onAbort = (): void => {
        this.abortPermission(permission_id);
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = (): void => {
        input.signal?.removeEventListener("abort", onAbort);
      };
    }

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
      this.takeWaiter(permission_id);
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
      this.takeWaiter(permission_id);
      if (row.status === "approved" || row.status === "rejected") {
        return { approved: row.status === "approved", reason: row.decision_reason ?? null };
      }
      throw new Error(`permission ${permission_id} expired`);
    }

    if (input.signal?.aborted) this.abortPermission(permission_id);

    return await promise;
  }

  private abortPermission(permissionId: string): void {
    this.abortedPermissions.add(permissionId);
    const waiter = this.takeWaiter(permissionId);
    if (!waiter) return;
    waiter.reject(permissionAbortError());
    setTimeout(() => {
      this.persistAbortedPermission(permissionId);
    }, 0);
  }

  private persistAbortedPermission(permissionId: string): void {
    const decidedAt = this.services.clock().toISOString();
    let row;
    try {
      row = this.services.permissionWriter.decide(permissionId, {
        decision: "reject",
        decided_by: "request_abort",
        decided_at: decidedAt,
        reason: "request aborted",
      });
    } catch (error) {
      this.services.log.warn(
        { err: String(error), permission_id: permissionId },
        "permission abort cleanup failed",
      );
      return;
    }
    if (!row) return;

    try {
      this.services.permissionEvents.emit({
        kind: "permission.decided",
        permission_id: row.permission_id,
        ts: decidedAt,
        payload: {
          permission_id: row.permission_id,
          parent_handoff_id: row.parent_handoff_id,
          conversation_id: row.conversation_id,
          agent_name: row.agent_name,
          tool_name: row.tool_name,
          decision: "reject",
          remember: null,
          decided_by: "request_abort",
          decided_at: decidedAt,
          reason: "request aborted",
        },
      });
    } catch (error) {
      this.services.log.warn(
        { err: String(error), permission_id: permissionId },
        "permission abort event failed",
      );
    }

    try {
      this.services.t0Writer.write({
        event_id: this.services.uuid(),
        ts: decidedAt,
        ingest_ts: decidedAt,
        source: "mcp",
        source_detail: "permission-audit",
        project_id: null,
        user_id: this.services.machineId.get(),
        machine_id: this.services.machineId.get(),
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
          decision: "reject",
          remember: null,
          decided_by: "request_abort",
          reason: "request aborted",
        },
        payload_summary: `reject ${row.tool_name}`,
      });
    } catch (error) {
      this.services.log.warn(
        { err: String(error), permission_id: permissionId },
        "permission abort audit failed",
      );
    }
    this.abortedPermissions.delete(permissionId);
  }

  private takeWaiter(permissionId: string): PermissionWaiter | undefined {
    const waiter = this.waiters.get(permissionId);
    if (!waiter) return undefined;
    this.waiters.delete(permissionId);
    waiter.cleanup();
    return waiter;
  }
}
