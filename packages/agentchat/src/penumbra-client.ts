import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDaemonStorageRoot } from '@penumbra/core';
import type { CreatePermissionRequest, ApprovePermissionRequest, DispatchEventInput, PermissionRequestRow } from '@penumbra/core';

export interface PenumbraClientOpts {
  storageRoot?: string;
  fetch?: typeof fetch;
}

export interface CreatePermissionResult {
  permission_id: string;
  status: string;
  ttl_at: string;
}

export interface DecidePermissionResult {
  permission_id: string;
  status: string;
  decided_at: string;
}

export class PenumbraClient {
  private readonly storageRoot: string | undefined;
  private readonly fetcher: typeof fetch;
  constructor(opts: PenumbraClientOpts = {}) {
    this.storageRoot = opts.storageRoot;
    this.fetcher = opts.fetch ?? fetch;
  }

  async observe(event: Record<string, unknown>): Promise<{ event_id: string }> {
    return this.post('/observations', event);
  }
  async createHandoff(body: {
    from: string; to: string; to_role?: string | null; message: string;
    conversation_id: string; project_id?: string | null; triggered_by_event_id: string;
    use_worktree?: boolean | number | null;
    chain_task_type?: string | null;
  }): Promise<{ handoff_id: string; status: string; routed_agent?: string; routed_role?: string; routing_task_type?: string }> {
    return this.post('/handoffs', body);
  }
  async listPending(opts?: { conversation_id?: string }): Promise<{ handoffs: any[] }> {
    const qs = opts?.conversation_id ? `?conversation_id=${encodeURIComponent(opts.conversation_id)}` : '';
    return this.get(`/handoffs/pending${qs}`);
  }
  async listHandoffs(opts: { statuses: string[]; conversation_id?: string }): Promise<{ handoffs: any[] }> {
    const params = new URLSearchParams();
    params.set('status', opts.statuses.join(','));
    if (opts.conversation_id) params.set('conversation_id', opts.conversation_id);
    return this.get(`/handoffs?${params.toString()}`);
  }
  async getHandoff(id: string): Promise<{ handoff: any }> {
    return this.get(`/handoffs/${id}`);
  }
  async getHandoffStatus(handoff_id: string): Promise<{
    handoff_id: string;
    status: string;
    error_summary: string | null;
    worker_id: string | null;
    started_at: string | null;
    resolved_at: string | null;
    latency_seconds: number | null;
    reliability: {
      status: string;
      trustworthy: boolean;
      recommended_action: string;
      summary: string;
    };
  }> {
    return this.get(`/handoffs/${encodeURIComponent(handoff_id)}/status`);
  }
  async getChainResponses(
    conversation_id: string,
    which: 'final' | 'all' = 'final',
  ): Promise<{ responses: { agent: string; text: string; error?: { message: string }; ts: string }[] }> {
    return this.get(`/chains/responses?conversation_id=${encodeURIComponent(conversation_id)}&which=${which}`);
  }
  async getDispatchTimeline(handoff_id: string): Promise<{ events: unknown[] }> {
    return this.get(`/dispatch/events?handoff_id=${encodeURIComponent(handoff_id)}`);
  }
  async dispatchAudit(handoff_id: string): Promise<{ report: any }> {
    return this.get(`/dispatch/audit?handoff_id=${encodeURIComponent(handoff_id)}`);
  }
  async inspectWorktree(handoff_id: string): Promise<{ worktree: any; diff_against_main: string; branch_log: string }> {
    return this.get(`/worktrees/${encodeURIComponent(handoff_id)}`);
  }
  async grepInWorktree(
    handoff_id: string,
    args: {
      path?: string;
      pattern: string;
      output_mode?: 'content' | 'path' | 'match';
      max_results?: number;
    },
  ): Promise<{ results: { path: string; line: number; text: string }[]; truncated: boolean }> {
    return this.post(`/worktrees/${encodeURIComponent(handoff_id)}/grep`, args);
  }
  async approve(id: string, body: { redirect_to?: string; reject?: boolean; reason?: string; resolved_by?: string } = {}): Promise<{ handoff_id: string; status: string }> {
    return this.post(`/handoffs/${id}/approve`, body);
  }
  async claimHandoff(id: string, worker_id: string): Promise<{ handoff_id: string; status: string }> {
    return this.post(`/handoffs/${id}/claim`, { worker_id });
  }
  async completeHandoff(id: string): Promise<{ handoff_id: string; status: string }> {
    return this.post(`/handoffs/${id}/complete`, {});
  }
  async markFailed(id: string, reason: string): Promise<{ handoff_id: string; status: string }> {
    return this.post(`/handoffs/${id}/fail`, { reason });
  }
  async postProgress(handoff_id: string, event: any): Promise<void> {
    return this.post(`/handoffs/${handoff_id}/progress`, event);
  }
  async postDispatchEvents(events: DispatchEventInput[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.post('/dispatch/events', { events });
    } catch {
      // Instrumentation is best-effort and must not break dispatch execution.
    }
  }
  async captureAgentPerformanceFromReconciler(body: {
    handoff_id: string;
    task_type?: string;
    result: Record<string, unknown>;
  }): Promise<void> {
    return this.post('/agents/performance/reconciler', body);
  }
  async captureAgentPerformanceFromDispatch(body: {
    handoff_id: string;
    task_type?: string;
    reason: 'completed' | 'max_hops' | 'cancelled' | 'error';
  }): Promise<void> {
    return this.post('/agents/performance/dispatch', body);
  }
  async postHeartbeat(worker_id: string): Promise<void> {
    return this.post('/worker/heartbeat', { worker_id });
  }
  async cancelConversation(id: string): Promise<void> {
    return this.post(`/conversations/${id}/cancel`, {});
  }
  async startChain(body: {
    initial_agent: string; message: string;
    conversation_id?: string; project_id?: string | null;
    max_hops?: number; trust_mode?: 'all' | 'config';
    use_worktree?: boolean | number | null;
    task_type?: string;
  }): Promise<{ conversation_id: string; handoff_id: string }> {
    return this.post('/chains/start', body);
  }
  async createPermission(body: CreatePermissionRequest): Promise<CreatePermissionResult> {
    return this.post('/permissions', body);
  }
  async getPermission(permission_id: string): Promise<{ permission: PermissionRequestRow }> {
    return this.get(`/permissions/${encodeURIComponent(permission_id)}`);
  }
  async listPermissions(opts?: { status?: string; conversation_id?: string; parent_handoff_id?: string }): Promise<{ permissions: PermissionRequestRow[] }> {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.conversation_id) params.set('conversation_id', opts.conversation_id);
    if (opts?.parent_handoff_id) params.set('parent_handoff_id', opts.parent_handoff_id);
    const qs = params.toString();
    return this.get(qs ? `/permissions?${qs}` : '/permissions');
  }
  async decidePermission(permission_id: string, body: ApprovePermissionRequest): Promise<DecidePermissionResult> {
    return this.post(`/permissions/${encodeURIComponent(permission_id)}/decide`, body);
  }
  async *subscribeHandoffEvents(opts: { signal?: AbortSignal } = {}): AsyncIterable<any> {
    yield* this.subscribeSse('/handoffs/events', 'handoff', opts.signal);
  }
  async *subscribeWorkerControl(opts: { signal?: AbortSignal } = {}): AsyncIterable<any> {
    yield* this.subscribeSse('/worker/control', 'control', opts.signal);
  }
  async *subscribeConversation(id: string, opts: { signal?: AbortSignal } = {}): AsyncIterable<any> {
    yield* this.subscribeSse(`/conversations/${id}/stream`, 'progress', opts.signal);
  }

  private async *subscribeSse(path: string, eventName: string, signal?: AbortSignal): AsyncIterable<any> {
    const { baseUrl, token } = this.resolve();
    const res = await this.fetcher(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`penumbra ${path}: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const eventLine = frame.split('\n').find((l) => l.startsWith(`event: ${eventName}`));
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (dataLine && eventLine) yield JSON.parse(dataLine.slice(6));
        }
      }
    } finally {
      reader.releaseLock();
      try { await res.body.cancel(); } catch { /* noop */ }
    }
  }

  private resolve(): { baseUrl: string; token: string } {
    const root = resolveDaemonStorageRoot({ explicit: this.storageRoot });
    const portPath = join(root, 'port');
    const tokenPath = join(root, 'token');
    if (!existsSync(portPath) || !existsSync(tokenPath)) {
      throw new Error(`penumbra not running at ${root} (missing port/token)`);
    }
    const port = Number(readFileSync(portPath, 'utf8').trim());
    const token = readFileSync(tokenPath, 'utf8').trim();
    return { baseUrl: `http://127.0.0.1:${port}`, token };
  }
  private async post<T>(path: string, body: unknown): Promise<T> {
    const { baseUrl, token } = this.resolve();
    const res = await this.fetcher(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errorBody = await res.json().catch(() => null);
      throw new PenumbraHttpError(`penumbra ${path}: HTTP ${res.status}`, res.status, errorBody);
    }
    return (await res.json()) as T;
  }
  private async get<T>(path: string): Promise<T> {
    const { baseUrl, token } = this.resolve();
    const res = await this.fetcher(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const errorBody = await res.json().catch(() => null);
      throw new PenumbraHttpError(`penumbra ${path}: HTTP ${res.status}`, res.status, errorBody);
    }
    return (await res.json()) as T;
  }
}

/**
 * HTTP error thrown by PenumbraClient when the daemon returns a non-2xx response.
 * Callers can branch on `status` to distinguish terminal (404, 409, 400) from
 * retryable (network, 5xx) failures without parsing error message strings.
 */
export class PenumbraHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: any = null,
  ) {
    super(message);
    this.name = 'PenumbraHttpError';
  }
}

/** Returns true for HTTP statuses that are NOT worth retrying (definitive outcomes). */
export function isTerminalHttpStatus(status: number): boolean {
  // 4xx other than 408/429 are caller errors that won't change on retry.
  // 408 (timeout) and 429 (rate-limit) are transient.
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}
