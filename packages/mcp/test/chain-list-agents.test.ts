import { expect, test } from 'bun:test';
import { z } from 'zod';
import { connectInMemory } from './helpers.js';
import { DaemonClient } from '../src/daemon-client.js';

test('chain.list_agents forwards to daemon and returns results', async () => {
  let receivedPath: string | undefined;
  let receivedMethod: string | undefined;

  const srv = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      receivedPath = url.pathname;
      receivedMethod = req.method;
      return Response.json({ agents: [{ name: 'planner' }, { name: 'executor' }] });
    },
  });

  let client: Awaited<ReturnType<typeof connectInMemory>> | undefined;
  try {
    const daemon = new DaemonClient({ baseUrl: `http://localhost:${srv.port}`, token: 't' });
    client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: 'chain.list_agents',
      arguments: {},
    });
    const parsed = z.object({
      content: z.array(z.object({ type: z.string(), text: z.string() })).min(1),
    }).parse(out);

    expect(JSON.parse(parsed.content[0].text)).toEqual({
      agents: [{ name: 'planner' }, { name: 'executor' }],
    });
    expect(receivedPath).toBe('/chains/agents');
    expect(receivedMethod).toBe('GET');
  } finally {
    await client?.close();
    srv.stop(true);
  }
});
