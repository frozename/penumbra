import { expect, test } from 'bun:test';
import { connectInMemory } from './helpers.js';
import { DaemonClient } from '../src/daemon-client.js';

test('memory.observe forwards to daemon and returns event_id', async () => {
  let received: unknown = null;
  let receivedMethod: string | undefined;
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      receivedMethod = req.method;
      received = await req.json();
      return Response.json({ event_id: 'e-42' });
    },
  });
  let client: Awaited<ReturnType<typeof connectInMemory>> | undefined;
  try {
    const daemon = new DaemonClient({ baseUrl: `http://localhost:${srv.port}`, token: 't' });
    client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: 'memory_observe',
      arguments: {
        ts: '2026-04-23T12:00:00Z',
        source: 'mcp',
        event_type: 'agent-prompt',
        lane: 'local',
        payload_json: { prompt: 'hi' },
      },
    });
    const content = (out as unknown as { content: { type: string; text: string }[] }).content;
    const text = content[0]!.text;
    expect(JSON.parse(text).event_id).toBe('e-42');
    expect(received).toMatchObject({ source: 'mcp', event_type: 'agent-prompt' });
    expect(receivedMethod).toBe('POST');
  } finally {
    await client?.close();
    srv.stop(true);
  }
});
