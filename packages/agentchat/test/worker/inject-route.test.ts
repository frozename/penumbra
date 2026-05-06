import { expect, test } from 'bun:test';
import { workerInjectRoute } from '../../src/worker/inject-route.js';
import { registerSession, unregisterSession } from '../../src/worker/session-registry.js';

test('POST /sessions/:handoff_id/inject accepts a supported session and forwards the prompt', async () => {
  const injected: any[] = [];
  registerSession('h-1', {
    adapter: 'stdio-acp',
    inject: async (message: any) => {
      injected.push(message);
    },
  });
  try {
    const res = await workerInjectRoute(
      new Request('http://x/sessions/h-1/inject', {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
        body: JSON.stringify({ content: 'hello there' }),
      }),
      'h-1',
      { token: 'token' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(injected).toEqual([{ role: 'user', text: 'hello there' }]);
  } finally {
    unregisterSession('h-1');
  }
});

test('POST /sessions/:handoff_id/inject returns 401 without bearer token', async () => {
  const res = await workerInjectRoute(
    new Request('http://x/sessions/h-1/inject', {
      method: 'POST',
      body: JSON.stringify({ content: 'hello there' }),
    }),
    'h-1',
    { token: 'token' },
  );
  expect(res.status).toBe(401);
});

test('POST /sessions/:handoff_id/inject returns 404 for an unknown handoff', async () => {
  const res = await workerInjectRoute(
    new Request('http://x/sessions/missing/inject', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({ content: 'hello there' }),
    }),
    'missing',
    { token: 'token' },
  );
  expect(res.status).toBe(404);
});

test('POST /sessions/:handoff_id/inject returns 409 for unsupported adapter sessions', async () => {
  registerSession('h-1', { adapter: 'unknown-adapter' });
  try {
    const res = await workerInjectRoute(
      new Request('http://x/sessions/h-1/inject', {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
        body: JSON.stringify({ content: 'hello there' }),
      }),
      'h-1',
      { token: 'token' },
    );
    expect(res.status).toBe(409);
  } finally {
    unregisterSession('h-1');
  }
});
