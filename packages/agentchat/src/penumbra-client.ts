import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PenumbraClientOpts {
  storageRoot: string;
}

export class PenumbraClient {
  private readonly storageRoot: string;
  constructor(opts: PenumbraClientOpts) { this.storageRoot = opts.storageRoot; }

  async observe(event: Record<string, unknown>): Promise<{ event_id: string }> {
    return this.post('/observations', event);
  }
  async createHandoff(body: {
    from: string; to: string; to_role?: string | null; message: string;
    conversation_id: string; project_id?: string | null; triggered_by_event_id: string;
  }): Promise<{ handoff_id: string; status: string }> {
    return this.post('/handoffs', body);
  }
  async listPending(opts?: { conversation_id?: string }): Promise<{ handoffs: any[] }> {
    const qs = opts?.conversation_id ? `?conversation_id=${encodeURIComponent(opts.conversation_id)}` : '';
    return this.get(`/handoffs/pending${qs}`);
  }
  async approve(id: string, body: { redirect_to?: string; reject?: boolean; reason?: string; resolved_by?: string } = {}): Promise<{ handoff_id: string; status: string }> {
    return this.post(`/handoffs/${id}/approve`, body);
  }

  private resolve(): { baseUrl: string; token: string } {
    const portPath = join(this.storageRoot, 'port');
    const tokenPath = join(this.storageRoot, 'token');
    if (!existsSync(portPath) || !existsSync(tokenPath)) {
      throw new Error(`penumbra not running at ${this.storageRoot} (missing port/token)`);
    }
    const port = Number(readFileSync(portPath, 'utf8').trim());
    const token = readFileSync(tokenPath, 'utf8').trim();
    return { baseUrl: `http://127.0.0.1:${port}`, token };
  }
  private async post<T>(path: string, body: unknown): Promise<T> {
    const { baseUrl, token } = this.resolve();
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`penumbra ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }
  private async get<T>(path: string): Promise<T> {
    const { baseUrl, token } = this.resolve();
    const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`penumbra ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}
