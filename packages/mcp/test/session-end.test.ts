import { expect, test } from 'bun:test';
import { connectInMemory } from './helpers.js';
import { DaemonClient } from '../src/daemon-client.js';

test('session.end forwards to daemon', async () => {
  let body: unknown = null;
  let receivedMethod: string | undefined;
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      receivedMethod = req.method;
      body = await req.json();
      return Response.json({ ok: true, rollup_id: 'r1' });
    },
  });
  let client: Awaited<ReturnType<typeof connectInMemory>> | undefined;
  try {
    const daemon = new DaemonClient({ baseUrl: `http://localhost:${srv.port}`, token: 't' });
    client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: 'session.end',
      arguments: { session_id: 'sX' },
    });
    const payload = JSON.parse(
      (out as unknown as { content: { type: string; text: string }[] }).content[0]!.text,
    );
    expect(payload.rollup_id).toBe('r1');
    expect(body).toEqual({ session_id: 'sX' });
    expect(receivedMethod).toBe('POST');
  } finally {
    await client?.close();
    srv.stop(true);
  }
});
