import { randomBytes } from 'node:crypto';

export interface PendingHandoffRow {
  handoff_id: string;
  from_agent: string;
  to_agent: string;
  message: string;
  ts: string;
  status: 'pending';
}

export interface E2EHarness {
  port: number;
  token: string;
  baseUrl: string;
  addPendingHandoff: (row: Omit<PendingHandoffRow, 'status'>) => void;
  getCalls: () => Array<{ method: string; path: string }>;
  stop: () => Promise<void>;
}

interface Call {
  method: string;
  path: string;
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
  calls: Call[];
}

export async function startE2EHarness(): Promise<E2EHarness> {
  const token = randomBytes(16).toString('hex');
  const state: HarnessState = { pending: [], calls: [] };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const path = `${url.pathname}${url.search}`;
      const method = request.method.toUpperCase();
      state.calls.push({ method, path });

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

      if (method === 'GET' && url.pathname === '/health') {
        return json({ status: 'ok' });
      }

      if (method === 'GET' && url.pathname === '/handoffs') {
        const status = url.searchParams.get('status');
        if (status !== 'pending') return json({ handoffs: [] });
        return json({ handoffs: state.pending });
      }

      if (method === 'POST' && url.pathname.startsWith('/handoffs/') && url.pathname.endsWith('/approve')) {
        const match = /^\/handoffs\/([^/]+)\/approve$/.exec(url.pathname);
        if (!match) return json({ error: 'not_found' }, { status: 404 });
        const handoffId = decodeURIComponent(match[1]);
        state.pending = state.pending.filter((row) => row.handoff_id !== handoffId);
        return json({ handoff_id: handoffId, status: 'approved' });
      }

      if (method === 'GET' && url.pathname === '/usage/quota_status') {
        return json({
          dispatched_count: 0,
          cap: 6,
          subscription: { synth_total: 0 },
        });
      }

      if (method === 'GET' && url.pathname === '/usage/subscription_pressure') {
        return json({ windows: [] });
      }

      if (method === 'GET' && url.pathname === '/chains') {
        return json({ chains: [] });
      }

      if (method === 'GET' && url.pathname === '/dispatch-events/stream') {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(': keepalive\n\n'));
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
      server.stop(true);
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
