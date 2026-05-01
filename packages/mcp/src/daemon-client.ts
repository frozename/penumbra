import type { AgentRankOutput, QuotaStatusOutput, RecentCostOutput, T0EventInput, RecallResult } from '@penumbra/core';
import { RecallRequestSchema } from '@penumbra/core';
import type { z } from 'zod';
type RecallInput = z.input<typeof RecallRequestSchema>;

export interface StaticDaemonClientOpts {
  baseUrl: string;
  token: string;
}
export interface DynamicDaemonClientOpts {
  resolve: () => { baseUrl: string; token: string };
}
export type DaemonClientOpts = StaticDaemonClientOpts | DynamicDaemonClientOpts;

export class DaemonHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export class DaemonClient {
  private readonly resolve: () => { baseUrl: string; token: string };

  constructor(opts: DaemonClientOpts) {
    if ('resolve' in opts) {
      this.resolve = () => {
        const cfg = opts.resolve();
        return { baseUrl: cfg.baseUrl.replace(/\/$/, ''), token: cfg.token };
      };
    } else {
      const cached = { baseUrl: opts.baseUrl.replace(/\/$/, ''), token: opts.token };
      this.resolve = () => cached;
    }
  }

  async observe(event: T0EventInput): Promise<{ event_id: string }> {
    return this.post('/observations', event);
  }

  async recall(req: RecallInput): Promise<{ results: RecallResult[] }> {
    return this.post('/recall', req);
  }

  async costRecent(req: { since?: string; project_id?: string | null }): Promise<RecentCostOutput> {
    const qs = new URLSearchParams();
    if (req.since) qs.set('since', req.since);
    if (req.project_id != null) qs.set('project_id', req.project_id);
    const q = qs.toString();
    return this.get(q ? `/usage/recent?${q}` : '/usage/recent');
  }

  async costQuotaStatus(req: { since?: string }): Promise<QuotaStatusOutput> {
    const qs = req.since ? `?since=${encodeURIComponent(req.since)}` : '';
    return this.get(`/usage/quota_status${qs}`);
  }

  async agentRank(req: { task_type: string; since?: string; min_samples?: number; include_neutral?: boolean; include_cost?: boolean }): Promise<AgentRankOutput> {
    const qs = new URLSearchParams();
    qs.set('task_type', req.task_type);
    if (req.since) qs.set('since', req.since);
    if (req.min_samples != null) qs.set('min_samples', String(req.min_samples));
    if (req.include_neutral != null) qs.set('include_neutral', String(req.include_neutral));
    if (req.include_cost != null) qs.set('include_cost', String(req.include_cost));
    return this.get(`/agents/rank?${qs.toString()}`);
  }

  async endSession(sessionId: string): Promise<{ ok: true }> {
    return this.post('/sessions/end', { session_id: sessionId });
  }

  async listPendingHandoffs(opts: { conversation_id?: string } = {}): Promise<{ handoffs: any[] }> {
    const qs = opts.conversation_id ? `?conversation_id=${encodeURIComponent(opts.conversation_id)}` : '';
    return this.get(`/handoffs/pending${qs}`);
  }

  async getLatestHandoff(conversation_id: string): Promise<{ handoff: any }> {
    return this.get(`/handoffs/latest?conversation_id=${encodeURIComponent(conversation_id)}`);
  }

  async getHandoff(handoff_id: string): Promise<{ handoff: any }> {
    return this.get(`/handoffs/${encodeURIComponent(handoff_id)}`);
  }

  async getHandoffStatus(handoff_id: string): Promise<{
    handoff_id: string;
    status: string;
    error_summary: string | null;
    worker_id: string | null;
    started_at: string | null;
    resolved_at: string | null;
    latency_seconds: number | null;
  }> {
    const { baseUrl, token } = this.resolve();
    const res = await fetch(`${baseUrl}/handoffs/${encodeURIComponent(handoff_id)}/status`, {
      headers: this.authHeaders(token),
    });
    if (res.status === 404) {
      throw new Error(`handoff not found: ${handoff_id}`);
    }
    if (!res.ok) throw await daemonHttpError(`/handoffs/${encodeURIComponent(handoff_id)}/status`, res);
    return (await res.json()) as {
      handoff_id: string;
      status: string;
      error_summary: string | null;
      worker_id: string | null;
      started_at: string | null;
      resolved_at: string | null;
      latency_seconds: number | null;
    };
  }

  async approveHandoff(handoff_id: string, body: { redirect_to?: string; reject?: boolean; reason?: string } = {}): Promise<{ handoff_id: string; status: string }> {
    return this.post(`/handoffs/${handoff_id}/approve`, body);
  }

  async startChain(body: {
    initial_agent: string; message: string;
    conversation_id?: string; project_id?: string | null;
    max_hops?: number; trust_mode?: 'all' | 'config';
    use_worktree?: boolean;
  }): Promise<{ conversation_id: string; handoff_id: string }> {
    return this.post('/chains/start', body);
  }

  async listWorktrees(): Promise<{ worktrees: any[] }> {
    return this.get('/worktrees');
  }

  async inspectWorktree(handoff_id: string): Promise<{ worktree: any; diff_against_main: string; branch_log: string }> {
    return this.get(`/worktrees/${encodeURIComponent(handoff_id)}`);
  }

  async globInWorktree(handoff_id: string, args: {
    pattern: string;
    path?: string | null;
    max_results?: number | null;
    include_ignored?: boolean | null;
  }): Promise<{ results: string[]; truncated: boolean }> {
    return this.post(`/worktrees/${encodeURIComponent(handoff_id)}/glob`, args);
  }

  async grepInWorktree(handoff_id: string, args: {
    pattern: string;
    path?: string | null;
    glob?: string | null;
    output_mode?: 'content' | 'files_with_matches';
    case_insensitive?: boolean | null;
    include_ignored?: boolean | null;
    max_results?: number | null;
  }): Promise<{ results: any[] | string[]; truncated: boolean }> {
    return this.post(`/worktrees/${encodeURIComponent(handoff_id)}/grep`, args);
  }

  async cleanupWorktree(handoff_id: string, force?: boolean): Promise<{ status: 'torn_down' | 'not_found' }> {
    const qs = force ? '?force=true' : '';
    return this.post(`/worktrees/${encodeURIComponent(handoff_id)}/cleanup${qs}`, {});
  }

  async cancelConversation(conversation_id: string): Promise<{ ok: true; changed: boolean }> {
    return this.post(`/conversations/${encodeURIComponent(conversation_id)}/cancel`, {});
  }

  async listChainHistory(conversation_id: string, limit: number = 50): Promise<{ history: any[] }> {
    return this.get(`/chains/history?conversation_id=${encodeURIComponent(conversation_id)}&limit=${limit}`);
  }

  async getChainMessages(conversation_id: string, types?: string[]): Promise<{
    events: {
      event_id: string;
      ts: string;
      event_type: string;
      source: string;
      source_detail: string | null;
      user_id: string | null;
      payload: unknown;
    }[]
  }> {
    let url = `/chains/messages?conversation_id=${encodeURIComponent(conversation_id)}`;
    if (types && types.length > 0) {
      url += `&types=${encodeURIComponent(types.join(','))}`;
    }
    return this.get(url);
  }

  async getChainResponses(
    conversation_id: string,
    which: 'final' | 'all' = 'final',
  ): Promise<{ responses: { agent: string, text: string, error?: { message: string }, ts: string }[] }> {
    return this.get(`/chains/responses?conversation_id=${encodeURIComponent(conversation_id)}&which=${which}`);
  }

  async reloadConfig(): Promise<{ ok: true; agent_count: number; reloaded_at: string }> {
    return this.post('/agentchat/reload', {});
  }

  async listChainAgents(): Promise<{ agents: { name: string }[] }> {
    return this.get('/chains/agents');
  }

  async listPermissions(opts: { status?: string; conversation_id?: string; parent_handoff_id?: string } = {}): Promise<{ permissions: any[] }> {
    const qs = new URLSearchParams();
    if (opts.status) qs.set('status', opts.status);
    if (opts.conversation_id) qs.set('conversation_id', opts.conversation_id);
    if (opts.parent_handoff_id) qs.set('parent_handoff_id', opts.parent_handoff_id);
    const q = qs.toString();
    return this.get(q ? `/permissions?${q}` : '/permissions');
  }

  async getPermission(permission_id: string): Promise<{ permission: any }> {
    return this.get(`/permissions/${encodeURIComponent(permission_id)}`);
  }

  async approvePermission(permission_id: string, body: { decision: 'approve' | 'reject'; remember?: 'this_call' | 'this_dispatch'; reason?: string }): Promise<{ permission_id: string; status: string; decided_at: string }> {
    return this.post(`/permissions/${encodeURIComponent(permission_id)}/decide`, body);
  }

  private async get<T>(path: string): Promise<T> {
    const { baseUrl, token } = this.resolve();
    const res = await fetch(`${baseUrl}${path}`, { headers: this.authHeaders(token) });
    if (!res.ok) throw await daemonHttpError(path, res);
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const { baseUrl, token } = this.resolve();
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(token),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await daemonHttpError(path, res);
    return (await res.json()) as T;
  }

  private authHeaders(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }
}

async function daemonHttpError(path: string, res: Response): Promise<DaemonHttpError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {}
  return new DaemonHttpError(`daemon ${path}: HTTP ${res.status}`, res.status, body);
}
