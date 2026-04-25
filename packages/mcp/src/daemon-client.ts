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
    if (!res.ok) throw new Error(`daemon ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}
