import { randomBytes } from 'node:crypto';

export interface PendingHandoffRow {
  handoff_id: string;
  from_agent: string;
  to_agent: string;
  message: string;
  ts: string;
  status: 'pending';
}

export interface ChainRow {
  conversation_id: string;
  project_id: string | null;
  latest_status: 'dispatched' | 'completed' | 'failed' | 'rejected' | 'expired' | 'pending';
  latest_ts: string;
  earliest_ts: string;
  handoff_count: number;
  root_handoff_id: string | null;
  to_agent: string | null;
  to_role: string | null;
  worktree_path: string | null;
  worktree_root: string | null;
}

export interface PressureWindow {
  used_pct: number;
  warn_pct: number;
  refuse_pct: number;
  provider: string;
  model: string;
  window_label: string;
}

export interface E2EHarness {
  port: number;
  token: string;
  baseUrl: string;
  addPendingHandoff: (row: Omit<PendingHandoffRow, 'status'>) => void;
  getCalls: () => Array<{ method: string; path: string; body?: unknown }>;
  stop: () => Promise<void>;
  addChain: (row: ChainRow) => void;
  setPressure: (windows: PressureWindow[]) => void;
  setQuotaStatus: (data: { dispatched_count: number; cap: number; subscription?: { synth_total: number } }) => void;
  pushEvent: (event: { event: string; data: unknown }) => void;
  simulateReconnect: () => void;
  injectError: (path: string, status: number) => void;
  clearErrors: () => void;
}

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

interface HarnessRow extends PendingHandoffRow {
  project_id: string | null;
  conversation_id: string;
  to_role: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  redirected_to: string | null;
  resolution_reason: string | null;
  triggered_by_event_id: string | null;
  chain_max_hops: number | null;
  chain_trust_mode: 'all' | 'config' | null;
  chain_task_type: string | null;
  use_worktree: boolean | null;
  error_message: string | null;
  cancel_requested_at: string | null;
  worker_id: string | null;
  parent_handoff_id: string | null;
}

interface HarnessState {
  pending: HarnessRow[];
  chains: ChainRow[];
  pressure: PressureWindow[];
  quotaStatus: { dispatched_count: number; cap: number; subscription: { synth_total: number } };
  calls: Call[];
  errors: Map<string, number>;
}

export async function startE2EHarness(): Promise<E2EHarness> {
  const token = randomBytes(16).toString('hex');
  const state: HarnessState = {
    pending: [],
    chains: [],
    pressure: [],
    quotaStatus: { dispatched_count: 0, cap: 6, subscription: { synth_total: 0 } },
    calls: [],
    errors: new Map(),
  };

  const sseControllers = new Set<ReadableStreamDefaultController<Uint8Array>>();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const simplePath = url.pathname;
      const path = `${simplePath}${url.search}`;
      const method = request.method.toUpperCase();

      let reqBody: unknown = undefined;
      if (method === 'POST' && request.headers.get('content-type')?.includes('json')) {
        try {
          reqBody = await request.clone().json();
        } catch {
          // ignore parse failures
        }
      }
      state.calls.push(method === 'POST' && reqBody !== undefined ? { method, path, body: reqBody } : { method, path });

      if (method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(),
        });
      }

      const auth = request.headers.get('authorization');
      if (auth !== `Bearer ${token}`) {
        return json({ error: 'unauthorized' }, { status: 401 });
      }

      if (method === 'GET' && simplePath === '/health') {
        return serveWithError('/health', () => json({ status: 'ok' }));
      }

      if (method === 'GET' && simplePath === '/handoffs') {
        const status = url.searchParams.get('status');
        if (status !== 'pending') return json({ handoffs: [] });
        return json({ handoffs: state.pending });
      }

      if (method === 'POST' && simplePath.startsWith('/handoffs/') && simplePath.endsWith('/approve')) {
        const match = /^\/handoffs\/([^/]+)\/approve$/.exec(simplePath);
        if (!match) return json({ error: 'not_found' }, { status: 404 });
        const handoffId = decodeURIComponent(match[1]);
        return serveWithError(simplePath, () => {
          const body = reqBody as Record<string, unknown> | undefined;
          if (body && body.reject === true) {
            const resolvedRow = state.pending.find((r) => r.handoff_id === handoffId);
            if (resolvedRow) {
              resolvedRow.status = 'rejected';
              resolvedRow.resolution_reason = typeof body.reason === 'string' ? body.reason : null;
              resolvedRow.resolved_at = new Date().toISOString();
            }
          }
          state.pending = state.pending.filter((row) => row.handoff_id !== handoffId);
          return json({
            handoff_id: handoffId,
            status: body && body.reject === true ? 'rejected' : 'approved',
          });
        });
      }

      if (method === 'GET' && simplePath === '/usage/quota_status') {
        return json(state.quotaStatus);
      }

      if (method === 'GET' && simplePath === '/usage/subscription_pressure') {
        return json({ windows: state.pressure });
      }

      if (method === 'GET' && simplePath === '/chains') {
        const status = url.searchParams.get('status');
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
        let filtered = state.chains;
        if (status) {
          if (status === 'dispatched') {
            filtered = filtered.filter((c) => c.latest_status === 'dispatched');
          } else if (status === 'completed') {
            filtered = filtered.filter(
              (c) => c.latest_status === 'completed' || c.latest_status === 'failed' || c.latest_status === 'rejected',
            );
          }
        }
        if (limit !== undefined && limit > 0) {
          filtered = filtered.slice(0, limit);
        }
        return json({ chains: filtered });
      }

      if (method === 'GET' && simplePath === '/dispatch-events/stream') {
        const encoder = new TextEncoder();
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            sseControllers.add(controller);
            controller.enqueue(encoder.encode(': keepalive\n\n'));
          },
          cancel() {
            sseControllers.delete(controller);
          },
        });

        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            ...corsHeaders(),
          },
        });
      }

      return json({ error: 'not_found' }, { status: 404 });
    },
  });

  function serveWithError(fullPath: string, handler: () => Response): Response {
    const status = state.errors.get(fullPath);
    if (status !== undefined) {
      state.errors.delete(fullPath);
      return json({ error: 'injected error' }, { status });
    }
    return handler();
  }

  function toHarnessRow(row: Omit<PendingHandoffRow, 'status'>): HarnessRow {
    return {
      ...row,
      status: 'pending',
      project_id: null,
      conversation_id: 'e2e-conversation',
      to_role: null,
      resolved_by: null,
      resolved_at: null,
      redirected_to: null,
      resolution_reason: null,
      triggered_by_event_id: null,
      chain_max_hops: null,
      chain_trust_mode: null,
      chain_task_type: null,
      use_worktree: null,
      error_message: null,
      cancel_requested_at: null,
      worker_id: null,
      parent_handoff_id: null,
    };
  }

  return {
    port: server.port,
    token,
    baseUrl: `http://127.0.0.1:${server.port}`,
    addPendingHandoff(row) {
      state.pending.push(toHarnessRow(row));
    },
    getCalls() {
      return state.calls.slice();
    },
    async stop() {
      sseControllers.clear();
      server.stop(true);
    },
    addChain(row) {
      state.chains.push({ ...row });
    },
    setPressure(windows) {
      state.pressure = windows.map((w) => ({ ...w }));
    },
    setQuotaStatus(data) {
      state.quotaStatus = {
        dispatched_count: data.dispatched_count,
        cap: data.cap,
        subscription: data.subscription ? { synth_total: data.subscription.synth_total } : { synth_total: 0 },
      };
    },
    pushEvent(event) {
      const encoder = new TextEncoder();
      const line = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
      const data = encoder.encode(line);
      for (const ctrl of sseControllers) {
        try {
          ctrl.enqueue(data);
        } catch {
          sseControllers.delete(ctrl);
        }
      }
    },
    simulateReconnect() {
      for (const ctrl of Array.from(sseControllers)) {
        try {
          ctrl.close();
        } catch {
          // already closed
        } finally {
          sseControllers.delete(ctrl);
        }
      }
    },
    injectError(path, status) {
      state.errors.set(path, status);
    },
    clearErrors() {
      state.errors.clear();
    },
  };
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
}

function json(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...corsHeaders(),
    },
  });
}
