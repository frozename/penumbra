import type { Logger } from '@penumbra/core';
import type { PermissionRequestRow } from '@penumbra/core';
import type { PenumbraClient } from '../penumbra-client.js';

export interface PermissionDecisionResult {
  decision: 'approve' | 'reject';
  remember: 'this_call' | 'this_dispatch' | null;
  reason: string | null;
}

export interface RequestPermissionInput {
  parent_handoff_id: string;
  conversation_id: string;
  agent_name: string;
  tool_name: string;
  raw_input: unknown;
  ttl_seconds: number;
}

interface Waiter {
  resolve: (d: PermissionDecisionResult) => void;
  reject: (e: Error) => void;
}

export interface EventSourceLike {
  addEventListener(name: string, fn: (evt: { data: string; lastEventId?: string }) => void): void;
  onReconnect?: (fn: () => void) => () => void;
  close(): void;
}

export interface PermissionDaemonClientOpts {
  penumbraClient: Pick<PenumbraClient, 'createPermission' | 'getPermission'>;
  /** Factory so tests can inject a fake. Defaults to native EventSource against `${baseUrl}/permissions/events`. */
  makeEventSource: () => EventSourceLike;
  uuid: () => string;
  log: Logger;
}

export class PermissionDaemonClient {
  private waiters = new Map<string, Waiter>();
  private es: EventSourceLike | null = null;
  private unsubscribeReconnect: (() => void) | null = null;

  constructor(private readonly opts: PermissionDaemonClientOpts) {}

  async start(): Promise<void> {
    if (this.es) return;
    this.es = this.opts.makeEventSource();
    // Native EventSource replays Last-Event-ID on reconnect, but this SSE route
    // currently keys ids as `permission_id:seq` while the parser accepts only `seq:<n>`.
    // We accept that limitation here; cold-reconnect convergence comes from the GET fallback.
    this.es.addEventListener('permission.decided', (evt) => {
      let payload: any;
      try { payload = JSON.parse(evt.data); } catch { return; }
      const w = this.waiters.get(payload.permission_id);
      if (!w) return;
      this.waiters.delete(payload.permission_id);
      w.resolve({
        decision: payload.decision,
        remember: payload.remember ?? null,
        reason: payload.reason ?? null,
      });
    });
    this.es.addEventListener('permission.expired', (evt) => {
      let payload: any;
      try { payload = JSON.parse(evt.data); } catch { return; }
      const w = this.waiters.get(payload.permission_id);
      if (!w) return;
      this.waiters.delete(payload.permission_id);
      w.reject(new Error(`permission ${payload.permission_id} expired`));
    });
    if (this.es.onReconnect) {
      this.unsubscribeReconnect = this.es.onReconnect(() => {
        void this.convergeWaiters().catch(() => {});
      });
    }
  }

  stop(): void {
    this.unsubscribeReconnect?.();
    this.unsubscribeReconnect = null;
    this.es?.close();
    this.es = null;
    for (const w of this.waiters.values()) {
      w.reject(new Error('PermissionDaemonClient stopped'));
    }
    this.waiters.clear();
  }

  async requestPermission(input: RequestPermissionInput): Promise<PermissionDecisionResult> {
    if (!this.es) throw new Error('PermissionDaemonClient not started');
    const permission_id = this.opts.uuid();
    // Register waiter BEFORE the POST so an instant decision can't slip past.
    const promise = new Promise<PermissionDecisionResult>((resolve, reject) => {
      this.waiters.set(permission_id, { resolve, reject });
    });
    try {
      await this.opts.penumbraClient.createPermission({
        permission_id,
        parent_handoff_id: input.parent_handoff_id,
        conversation_id: input.conversation_id,
        agent_name: input.agent_name,
        tool_name: input.tool_name,
        raw_input: input.raw_input,
        ttl_seconds: input.ttl_seconds,
      });
    } catch (err) {
      this.waiters.delete(permission_id);
      throw err;
    }
    return promise;
  }

  private async convergeWaiters(): Promise<void> {
    const permissionIds = [...this.waiters.keys()];
    await Promise.all(permissionIds.map(async (permission_id) => {
      try {
        const { permission } = await this.opts.penumbraClient.getPermission(permission_id);
        await this.convergeWaiter(permission_id, permission);
      } catch (err: any) {
        const status = typeof err?.status === 'number' ? err.status : null;
        if (status !== 404) return;
        const waiter = this.waiters.get(permission_id);
        if (!waiter) return;
        this.waiters.delete(permission_id);
        waiter.reject(new Error(`permission ${permission_id} not found`));
      }
    }));
  }

  private async convergeWaiter(permission_id: string, permission: PermissionRequestRow): Promise<void> {
    const waiter = this.waiters.get(permission_id);
    if (!waiter) return;
    if (permission.status === 'pending') return;

    this.waiters.delete(permission_id);
    if (permission.status === 'approved' || permission.status === 'rejected') {
      waiter.resolve({
        decision: permission.status === 'approved' ? 'approve' : 'reject',
        remember: permission.remember_scope,
        reason: permission.decision_reason,
      });
      return;
    }

    waiter.reject(new Error(`permission ${permission_id} expired`));
  }
}
