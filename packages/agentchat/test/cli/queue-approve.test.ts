import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runQueue } from '../../src/cli/queue.js';
import { runApprove } from '../../src/cli/approve.js';

test('runQueue lists pending handoffs by hitting penumbra', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({
      handoffs: [{
        handoff_id: 'h1111111-aaaa-bbbb-cccc-dddddddddddd', ts: 't', from_agent: 'a', to_agent: 'b',
        message: 'go', status: 'pending', conversation_id: 'c', project_id: null,
        to_role: null, resolved_by: null, resolved_at: null, redirected_to: null,
        triggered_by_event_id: null,
      }],
    }),
  });
  const root = mkdtempSync(join(tmpdir(), 'aq-'));
  writeFileSync(join(root, 'port'), `${server.port}\n`);
  writeFileSync(join(root, 'token'), 'tk\n');

  const rows = await runQueue({ storageRoot: root });
  expect(rows.length).toBe(1);
  expect(rows[0]!.handoff_id).toBe('h1111111-aaaa-bbbb-cccc-dddddddddddd');
  server.stop(true);
});

test('runApprove resolves a short prefix to the matching pending handoff', async () => {
  const requests: { url: string; body: any }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/handoffs/pending') {
        return Response.json({
          handoffs: [
            { handoff_id: 'abcd1234-aaaa-bbbb-cccc-000000000000', ts: 't', from_agent: 'a', to_agent: 'b', message: '', status: 'pending', conversation_id: 'c', project_id: null, to_role: null, resolved_by: null, resolved_at: null, redirected_to: null, triggered_by_event_id: null },
            { handoff_id: 'ef567890-aaaa-bbbb-cccc-000000000000', ts: 't', from_agent: 'a', to_agent: 'b', message: '', status: 'pending', conversation_id: 'c', project_id: null, to_role: null, resolved_by: null, resolved_at: null, redirected_to: null, triggered_by_event_id: null },
          ],
        });
      }
      requests.push({ url: url.pathname, body: await req.json() });
      return Response.json({ handoff_id: 'ef567890-aaaa-bbbb-cccc-000000000000', status: 'rejected' });
    },
  });
  const root = mkdtempSync(join(tmpdir(), 'aq-'));
  writeFileSync(join(root, 'port'), `${server.port}\n`);
  writeFileSync(join(root, 'token'), 'tk\n');

  const result = await runApprove({ storageRoot: root, handoffId: 'ef56789', reject: true });
  expect(result.status).toBe('rejected');
  expect(requests[0]!.url).toBe('/handoffs/ef567890-aaaa-bbbb-cccc-000000000000/approve');
  server.stop(true);
});

test('runApprove errors on ambiguous prefix', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({
      handoffs: [
        { handoff_id: 'abcd1234-aaaa-bbbb-cccc-000000000000', ts: 't', from_agent: 'a', to_agent: 'b', message: '', status: 'pending', conversation_id: 'c', project_id: null, to_role: null, resolved_by: null, resolved_at: null, redirected_to: null, triggered_by_event_id: null },
        { handoff_id: 'abcd9999-aaaa-bbbb-cccc-000000000000', ts: 't', from_agent: 'a', to_agent: 'b', message: '', status: 'pending', conversation_id: 'c', project_id: null, to_role: null, resolved_by: null, resolved_at: null, redirected_to: null, triggered_by_event_id: null },
      ],
    }),
  });
  const root = mkdtempSync(join(tmpdir(), 'aq-'));
  writeFileSync(join(root, 'port'), `${server.port}\n`);
  writeFileSync(join(root, 'token'), 'tk\n');

  await expect(runApprove({ storageRoot: root, handoffId: 'abcd' })).rejects.toThrow(/ambiguous/i);
  server.stop(true);
});

test('runApprove errors when prefix matches no pending handoff', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ handoffs: [] }),
  });
  const root = mkdtempSync(join(tmpdir(), 'aq-'));
  writeFileSync(join(root, 'port'), `${server.port}\n`);
  writeFileSync(join(root, 'token'), 'tk\n');

  await expect(runApprove({ storageRoot: root, handoffId: 'deadbeef' })).rejects.toThrow(/no pending handoff/i);
  server.stop(true);
});

test('runApprove POSTs approve with optional redirect', async () => {
  let received: { url: string; body: any } | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received = { url: new URL(req.url).pathname, body: await req.json() };
      return Response.json({ handoff_id: 'h1111111-aaaa-bbbb-cccc-dddddddddddd', status: 'approved' });
    },
  });
  const root = mkdtempSync(join(tmpdir(), 'aq-'));
  writeFileSync(join(root, 'port'), `${server.port}\n`);
  writeFileSync(join(root, 'token'), 'tk\n');

  const result = await runApprove({ storageRoot: root, handoffId: 'h1111111-aaaa-bbbb-cccc-dddddddddddd' });
  expect(result.status).toBe('approved');
  expect(received!.url).toBe('/handoffs/h1111111-aaaa-bbbb-cccc-dddddddddddd/approve');

  await runApprove({ storageRoot: root, handoffId: 'h1111111-aaaa-bbbb-cccc-dddddddddddd', redirectTo: 'codex' });
  expect(received!.body).toEqual({ redirect_to: 'codex' });
  server.stop(true);
});

test('runApprove passes resolved_by in the request body', async () => {
  let received: { body: any } | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received = { body: await req.json() };
      return Response.json({ handoff_id: 'h2222222-aaaa-bbbb-cccc-dddddddddddd', status: 'approved' });
    },
  });
  const root = mkdtempSync(join(tmpdir(), 'aq-'));
  writeFileSync(join(root, 'port'), `${server.port}\n`);
  writeFileSync(join(root, 'token'), 'tk\n');

  await runApprove({ storageRoot: root, handoffId: 'h2222222-aaaa-bbbb-cccc-dddddddddddd', resolvedBy: 'auto' });
  expect(received!.body).toEqual({ resolved_by: 'auto' });
  server.stop(true);
});
