import type { T0EventInput, RecallRequest, RecallResult } from '@penumbra/core';

export interface DaemonClientOpts {
  baseUrl: string;
  token: string;
}

export class DaemonClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(opts: DaemonClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
  }

  async observe(event: T0EventInput): Promise<{ event_id: string }> {
    return this.post('/observations', event);
  }

  async recall(req: Partial<RecallRequest> & { query: string; project_id: string | null }): Promise<{ results: RecallResult[] }> {
    return this.post('/recall', req);
  }

  async endSession(sessionId: string): Promise<{ ok: true }> {
    return this.post('/sessions/end', { session_id: sessionId });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`daemon ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}
