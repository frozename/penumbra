import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PenumbraClient } from '../src/penumbra-client.js';

test('observe POSTs /observations with bearer token', async () => {
  let received: { body: any; auth: string | null } | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received = { body: await req.json(), auth: req.headers.get('authorization') };
      return Response.json({ event_id: 'e' });
    },
  });
  const root = mkdtempSync(join(tmpdir(), 'pen-client-'));
  writeFileSync(join(root, 'port'), `${server.port}\n`);
  writeFileSync(join(root, 'token'), 'tk\n');

  const client = new PenumbraClient({ storageRoot: root });
  await client.observe({
    ts: '2026-04-25T20:00:00Z',
    source: 'mcp',
    event_type: 'agent-prompt',
    lane: 'unknown',
    payload_json: {},
    user_id: 'u', machine_id: 'm',
  });
  expect(received).not.toBeNull();
  expect(received!.auth).toBe('Bearer tk');
  server.stop(true);
});

test('createHandoff POSTs /handoffs and returns the new id', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ handoff_id: 'h-1', status: 'pending' }),
  });
  const root = mkdtempSync(join(tmpdir(), 'pen-client-'));
  writeFileSync(join(root, 'port'), `${server.port}\n`);
  writeFileSync(join(root, 'token'), 'tk\n');

  const client = new PenumbraClient({ storageRoot: root });
  const r = await client.createHandoff({
    from: 'claude', to: 'gemini', message: 'go',
    conversation_id: 'c-1', project_id: null, triggered_by_event_id: 'e-1',
  });
  expect(r.handoff_id).toBe('h-1');
  expect(r.status).toBe('pending');
  server.stop(true);
});
