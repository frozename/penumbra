import type { T0EventInput, RecallResult } from '@penumbra/core';
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

  async approveHandoff(handoff_id: string, body: { redirect_to?: string; reject?: boolean; reason?: string } = {}): Promise<{ handoff_id: string; status: string }> {
    return this.post(`/handoffs/${handoff_id}/approve`, body);
  }

  async startChain(body: {
    initial_agent: string; message: string;
    conversation_id?: string; project_id?: string | null;
    max_hops?: number; trust_mode?: 'all' | 'config';
  }): Promise<{ conversation_id: string; handoff_id: string }> {
    return this.post('/chains/start', body);
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

  async listChainAgents(): Promise<{ agents: { name: string }[] }> {
    return this.get('/chains/agents');
  }

  private async get<T>(path: string): Promise<T> {
    const { baseUrl, token } = this.resolve();
    const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw await daemonHttpError(path, res);
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const { baseUrl, token } = this.resolve();
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await daemonHttpError(path, res);
    return (await res.json()) as T;
  }
}

async function daemonHttpError(path: string, res: Response): Promise<DaemonHttpError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {}
  return new DaemonHttpError(`daemon ${path}: HTTP ${res.status}`, res.status, body);
}
