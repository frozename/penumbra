import { expect, test } from 'bun:test';
import { connectInMemory } from './helpers.js';
import { DaemonClient } from '../src/daemon-client.js';

test('chain.history forwards to daemon and returns results', async () => {
  let receivedPath: string | undefined;
  let receivedMethod: string | undefined;
  let receivedQuery: string | undefined;

  const mockHistory = [
    {
      ts: '2026-04-27T01:48:00Z',
      reason: 'max_hops reached',
      hop_count: 5,
      terminal_handoff_id: 'h1',
      conversation_id: 'c1',
    },
  ];

  const srv = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      receivedPath = url.pathname;
      receivedMethod = req.method;
      receivedQuery = url.search;
      return Response.json({ history: mockHistory });
    },
  });

  let client: Awaited<ReturnType<typeof connectInMemory>> | undefined;
  try {
    const daemon = new DaemonClient({ baseUrl: `http://localhost:${srv.port}`, token: 't' });
    client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: 'chain.history',
      arguments: { conversation_id: 'c1' },
    });
    const content = (out as unknown as { content: { type: string; text: string }[] }).content;
    const history = JSON.parse(content[0]!.text);
    
    expect(history).toEqual(mockHistory);
    expect(receivedPath).toBe('/chains/history');
    expect(receivedMethod).toBe('GET');
    expect(receivedQuery).toContain('conversation_id=c1');
  } finally {
    await client?.close();
    srv.stop(true);
  }
});
