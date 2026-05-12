import { expect, test } from 'bun:test';
import { z } from 'zod';
import { DaemonClient } from '../../src/daemon-client.js';
import { LaneLedgerRecentInputShape, laneLedgerRecentHandler } from '../../src/tools/lane-ledger-recent.js';

function makeDaemon(fetchImpl: typeof fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const daemon = new DaemonClient({ baseUrl: 'http://daemon', token: 't' });
  return {
    daemon,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test('LaneLedgerRecentInputShape accepts optional lane query filters', () => {
  const schema = z.object(LaneLedgerRecentInputShape);
  expect(schema.parse({})).toEqual({});
  expect(schema.parse({ status: 'passed', limit: 10, task_class: 'STANDARD', since: '2026-01-01T00:00:00Z' })).toEqual({
    status: 'passed',
    limit: 10,
    task_class: 'STANDARD',
    since: '2026-01-01T00:00:00Z',
  });
  expect(() => schema.parse({ status: 'bad' })).toThrow();
  expect(() => schema.parse({ limit: 0 })).toThrow();
});

test('laneLedgerRecentHandler GETs /lanes/recent with filters and returns lanes response', async () => {
  let receivedMethod: string | undefined;
  let receivedPath: string | undefined;
  let receivedSearch: string | undefined;
  let receivedAuth: string | undefined;
  const { daemon, restore } = makeDaemon(async (input, init) => {
    const url = new URL(String(input));
    receivedMethod = init?.method;
    receivedPath = url.pathname;
    receivedSearch = url.search;
    receivedAuth = init?.headers ? new Headers(init.headers as HeadersInit).get('authorization') ?? undefined : undefined;
    return Response.json({ lanes: [] });
  });

  try {
    const out = await laneLedgerRecentHandler(daemon)({ status: 'passed', limit: 10 });

    expect(receivedMethod).toBe('GET');
    expect(receivedPath).toBe('/lanes/recent');
    expect(receivedSearch).toBe('?status=passed&limit=10');
    expect(receivedAuth).toBe('Bearer t');
    expect(out).toEqual({ lanes: [] });
  } finally {
    restore();
  }
});

test('laneLedgerRecentHandler omits query params when no filters are given', async () => {
  let receivedSearch: string | undefined;
  const { daemon, restore } = makeDaemon(async (input) => {
    receivedSearch = new URL(String(input)).search;
    return Response.json({ lanes: [] });
  });

  try {
    await laneLedgerRecentHandler(daemon)({});
    expect(receivedSearch).toBe('');
  } finally {
    restore();
  }
});

test('laneLedgerRecentHandler surfaces daemon 400 errors', async () => {
  const { daemon, restore } = makeDaemon(async () => new Response(JSON.stringify({ error: { code: 'validation_failed' } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    await expect(laneLedgerRecentHandler(daemon)({ status: 'failed' })).rejects.toThrow('daemon /lanes/recent: HTTP 400');
  } finally {
    restore();
  }
});
