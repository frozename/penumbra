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
        handoff_id: 'h-1', ts: 't', from_agent: 'a', to_agent: 'b',
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
  expect(rows[0]!.handoff_id).toBe('h-1');
  server.stop(true);
});

test('runApprove POSTs approve with optional redirect', async () => {
  let received: { url: string; body: any } | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received = { url: new URL(req.url).pathname, body: await req.json() };
      return Response.json({ handoff_id: 'h-1', status: 'approved' });
    },
  });
  const root = mkdtempSync(join(tmpdir(), 'aq-'));
  writeFileSync(join(root, 'port'), `${server.port}\n`);
  writeFileSync(join(root, 'token'), 'tk\n');

  const result = await runApprove({ storageRoot: root, handoffId: 'h-1' });
  expect(result.status).toBe('approved');
  expect(received!.url).toBe('/handoffs/h-1/approve');

  await runApprove({ storageRoot: root, handoffId: 'h-1', redirectTo: 'codex' });
  expect(received!.body).toEqual({ redirect_to: 'codex' });
  server.stop(true);
});
