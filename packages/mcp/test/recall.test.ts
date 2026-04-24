import { expect, test } from 'bun:test';
import { connectInMemory } from './helpers.js';
import { DaemonClient } from '../src/daemon-client.js';

test('memory.recall forwards to daemon and returns results', async () => {
  let receivedPath: string | undefined;
  let receivedMethod: string | undefined;
  const srv = Bun.serve({
    port: 0,
    fetch: (req) => {
      receivedPath = new URL(req.url).pathname;
      receivedMethod = req.method;
      return Response.json({
        results: [{ id: 'r1', tier: 't1', score: 0.9, body: 'hit', title: null,
          project_id: null, source_session_ids: ['s1'], created_at: '2026-04-23T12:00:00Z' }],
      });
    },
  });
  let client: Awaited<ReturnType<typeof connectInMemory>> | undefined;
  try {
    const daemon = new DaemonClient({ baseUrl: `http://localhost:${srv.port}`, token: 't' });
    client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: 'memory.recall',
      arguments: { query: 'anything', project_id: null, limit: 5 },
    });
    const content = (out as unknown as { content: { type: string; text: string }[] }).content;
    const payload = JSON.parse(content[0]!.text);
    expect(payload.results[0].id).toBe('r1');
    expect(receivedPath).toBe('/recall');
    expect(receivedMethod).toBe('POST');
  } finally {
    await client?.close();
    srv.stop(true);
  }
});
