import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

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
  latest_status:
    | 'dispatched'
    | 'completed'
    | 'failed'
    | 'rejected'
    | 'expired'
    | 'pending';
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
  setQuotaStatus: (data: {
    dispatched_count: number;
    cap: number;
    subscription?: { synth_total: number };
  }) => void;
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
  quotaStatus: {
    dispatched_count: number;
    cap: number;
    subscription: { synth_total: number };
  };
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

  const sseClients = new Set<ServerResponse<IncomingMessage>>();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const simplePath = url.pathname;
    const path = `${simplePath}${url.search}`;
    const method = (request.method ?? 'GET').toUpperCase();

    let reqBody: unknown;
    if (method === 'POST' && request.headers['content-type']?.includes('json')) {
      reqBody = await readJsonBody(request);
    }

    state.calls.push(
      method === 'POST' && reqBody !== undefined
        ? { method, path, body: reqBody }
        : { method, path },
    );

    if (method === 'OPTIONS') {
      sendEmpty(response, 204);
      return;
    }

    const auth = request.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      sendJson(response, { error: 'unauthorized' }, 401);
      return;
    }

    if (method === 'GET' && simplePath === '/health') {
      serveWithError(state, '/health', response, () => {
        sendJson(response, { status: 'ok' });
      });
      return;
    }

    if (method === 'GET' && simplePath === '/handoffs') {
      const status = url.searchParams.get('status');
      if (status !== 'pending') {
        sendJson(response, { handoffs: [] });
        return;
      }
      sendJson(response, { handoffs: state.pending });
      return;
    }

    if (
      method === 'POST' &&
      simplePath.startsWith('/handoffs/') &&
      simplePath.endsWith('/approve')
    ) {
      const match = /^\/handoffs\/([^/]+)\/approve$/.exec(simplePath);
      if (!match) {
        sendJson(response, { error: 'not_found' }, 404);
        return;
      }

      const handoffId = decodeURIComponent(match[1]);
      serveWithError(state, simplePath, response, () => {
        const body = reqBody as Record<string, unknown> | undefined;
        if (body?.reject === true) {
          const resolvedRow = state.pending.find((r) => r.handoff_id === handoffId);
          if (resolvedRow) {
            resolvedRow.status = 'rejected';
            resolvedRow.resolution_reason =
              typeof body.reason === 'string' ? body.reason : null;
            resolvedRow.resolved_at = new Date().toISOString();
          }
        }

        state.pending = state.pending.filter((row) => row.handoff_id !== handoffId);
        sendJson(response, {
          handoff_id: handoffId,
          status: body?.reject === true ? 'rejected' : 'approved',
        });
      });
      return;
    }

    if (method === 'GET' && simplePath === '/usage/quota_status') {
      sendJson(response, state.quotaStatus);
      return;
    }

    if (method === 'GET' && simplePath === '/usage/subscription_pressure') {
      sendJson(response, { windows: state.pressure });
      return;
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
            (c) =>
              c.latest_status === 'completed' ||
              c.latest_status === 'failed' ||
              c.latest_status === 'rejected',
          );
        }
      }

      if (limit !== undefined && limit > 0) {
        filtered = filtered.slice(0, limit);
      }

      sendJson(response, { chains: filtered });
      return;
    }

    if (method === 'GET' && simplePath === '/dispatch-events/stream') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...corsHeaders(),
      });
      response.write(': keepalive\n\n');
      sseClients.add(response);
      request.on('close', () => {
        sseClients.delete(response);
      });
      return;
    }

    sendJson(response, { error: 'not_found' }, 404);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to resolve e2e harness address');
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
    port: address.port,
    token,
    baseUrl: `http://127.0.0.1:${address.port}`,
    addPendingHandoff(row) {
      state.pending.push(toHarnessRow(row));
    },
    getCalls() {
      return state.calls.slice();
    },
    async stop() {
      for (const client of Array.from(sseClients)) {
        try {
          client.end();
        } catch {
          // ignore teardown races
        } finally {
          sseClients.delete(client);
        }
      }

      if (!server.listening) return;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
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
        subscription: data.subscription
          ? { synth_total: data.subscription.synth_total }
          : { synth_total: 0 },
      };
    },
    pushEvent(event) {
      const line = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
      for (const client of Array.from(sseClients)) {
        try {
          client.write(line);
        } catch {
          sseClients.delete(client);
        }
      }
    },
    simulateReconnect() {
      for (const client of Array.from(sseClients)) {
        try {
          client.end();
        } catch {
          // already closed
        } finally {
          sseClients.delete(client);
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

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function serveWithError(
  state: HarnessState,
  fullPath: string,
  response: ServerResponse<IncomingMessage>,
  handler: () => void,
): void {
  const status = state.errors.get(fullPath);
  if (status !== undefined) {
    state.errors.delete(fullPath);
    sendJson(response, { error: 'injected error' }, status);
    return;
  }
  handler();
}

function corsHeaders(): Record<string, string> {
  // Browser fetches use credentials: 'include' (HttpOnly cookie path), so the
  // origin must be echoed exactly and credentials must be allowed; '*' would
  // make the browser drop the response after preflight.
  return {
    'access-control-allow-origin': 'http://127.0.0.1:5176',
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'Origin',
  };
}

function sendEmpty(
  response: ServerResponse<IncomingMessage>,
  status: number,
): void {
  response.writeHead(status, corsHeaders());
  response.end();
}

function sendJson(
  response: ServerResponse<IncomingMessage>,
  body: unknown,
  status = 200,
): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    ...corsHeaders(),
  });
  response.end(JSON.stringify(body));
}
