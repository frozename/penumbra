import { expect, test } from 'bun:test';
import { z } from 'zod';
import { connectInMemory } from './helpers.js';
import { DaemonClient } from '../src/daemon-client.js';

test('chain.get_messages forwards to daemon and returns results', async () => {
  let receivedPath: string | undefined;
  let receivedMethod: string | undefined;
  let receivedQuery: string | undefined;

  const mockEvents = [
    {
      event_id: 'ev1',
      ts: '2026-04-27T01:48:00Z',
      event_type: 'user-prompt',
      source: 'agentchat',
      source_detail: 'chain-start',
      user_id: 'local-user',
      payload: { prompt: 'hello' }
    },
  ];

  const srv = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      receivedPath = url.pathname;
      receivedMethod = req.method;
      receivedQuery = url.search;
      return Response.json({ events: mockEvents });
    },
  });

  let client: Awaited<ReturnType<typeof connectInMemory>> | undefined;
  try {
    const daemon = new DaemonClient({ baseUrl: `http://localhost:${srv.port}`, token: 't' });
    client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: 'chain_get_messages',
      arguments: { conversation_id: 'c1', types: ['user-prompt', 'agent-response'] },
    });
    const parsed = z.object({
      content: z.array(z.object({ type: z.string(), text: z.string() })).min(1),
    }).parse(out);
    const result = JSON.parse(parsed.content[0].text);
    
    expect(result.events).toEqual(mockEvents);
    expect(receivedPath).toBe('/chains/messages');
    expect(receivedMethod).toBe('GET');
    expect(receivedQuery).toContain('conversation_id=c1');
    expect(receivedQuery).toContain('types=user-prompt%2Cagent-response');
  } finally {
    await client?.close();
    srv.stop(true);
  }
});
