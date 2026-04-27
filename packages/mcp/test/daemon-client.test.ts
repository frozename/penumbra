import { expect, test } from 'bun:test';
import { DaemonClient } from '../src/daemon-client.js';

test('observe POSTs to /observations with bearer token', async () => {
  let received: { headers: Headers; body: unknown } | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received = { headers: req.headers, body: await req.json() };
      return Response.json({ event_id: 'x' });
    },
  });
  try {
    const c = new DaemonClient({ baseUrl: `http://localhost:${server.port}`, token: 'tk' });
    const r = await c.observe({ source: 'mcp', event_type: 'agent-prompt',
      ts: '2026-04-23T12:00:00Z', lane: 'local', payload_json: {},
      user_id: 'u1', machine_id: 'm1' });
    expect(r.event_id).toBe('x');
    expect(received!.headers.get('authorization')).toBe('Bearer tk');
  } finally { server.stop(true); }
});

test('recall POSTs to /recall and returns results', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ results: [{ id: 'a', tier: 't1', score: 0.9, body: 'x',
      title: null, project_id: null, source_session_ids: [], created_at: 'now' }] }),
  });
  try {
    const c = new DaemonClient({ baseUrl: `http://localhost:${server.port}`, token: 'tk' });
    const r = await c.recall({ query: 'q', project_id: null });
    expect(r.results[0]!.id).toBe('a');
  } finally { server.stop(true); }
});

test('recall throws on non-2xx', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('boom', { status: 500 }) });
  try {
    const c = new DaemonClient({ baseUrl: `http://localhost:${server.port}`, token: 'tk' });
    await expect(c.recall({ query: 'q', project_id: null })).rejects.toThrow(/HTTP 500/);
  } finally { server.stop(true); }
});

test('resolves baseUrl/token lazily so daemon restarts at a new port stay reachable', async () => {
  // First daemon
  const server1 = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
  // Second daemon (mimics what `penumbra start` does after a stop+start: new port).
  const server2 = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });

  let current = { baseUrl: `http://localhost:${server1.port}`, token: 'tk1' };
  const c = new DaemonClient({ resolve: () => current });

  try {
    await c.endSession('s1');
    // Stop server1 and point the resolver at server2 — DaemonClient must pick that up.
    server1.stop(true);
    current = { baseUrl: `http://localhost:${server2.port}`, token: 'tk2' };
    const r = await c.endSession('s2');
    expect(r.ok).toBe(true);
  } finally {
    try { server1.stop(true); } catch { /* already stopped */ }
    server2.stop(true);
  }
});

test('endSession POSTs to /sessions/end with session_id body', async () => {
  let received: { url: string; body: unknown } | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received = { url: new URL(req.url).pathname, body: await req.json() };
      return Response.json({ ok: true });
    },
  });
  try {
    const c = new DaemonClient({ baseUrl: `http://localhost:${server.port}`, token: 'tk' });
    const r = await c.endSession('sess-123');
    expect(received!.url).toBe('/sessions/end');
    expect((received!.body as { session_id: string }).session_id).toBe('sess-123');
    expect(r.ok).toBe(true);
  } finally { server.stop(true); }
});

test('listChainAgents GETs /chains/agents and returns ordered names', async () => {
  let receivedPath: string | null = null;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      receivedPath = new URL(req.url).pathname;
      return Response.json({ agents: [{ name: 'planner' }, { name: 'executor' }] });
    },
  });
  try {
    const c = new DaemonClient({ baseUrl: `http://localhost:${server.port}`, token: 'tk' });
    const r = await c.listChainAgents();
    expect(receivedPath).toBe('/chains/agents');
    expect(r).toEqual({ agents: [{ name: 'planner' }, { name: 'executor' }] });
  } finally { server.stop(true); }
});
