import { expect, test } from 'bun:test';
import { z } from 'zod';
import { connectInMemory } from './helpers.js';
import { DaemonClient } from '../src/daemon-client.js';

test('reconciler.verdicts forwards to daemon and returns results', async () => {
  let receivedPath: string | undefined;
  let receivedMethod: string | undefined;
  let receivedQuery: string | undefined;

  const mockVerdicts = [
    {
      event_id: 'v-1',
      ts: '2026-05-08T00:00:00.000Z',
      handoff_id: 'h-1',
      conversation_id: 'c-1',
      to_agent: 'codex-mini',
      verdict: {
        branch: 'agent/h-1',
        typecheck: 'pass',
        tests: 'pass',
        pr_url: null,
      },
    },
  ];

  const srv = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      receivedPath = url.pathname;
      receivedMethod = req.method;
      receivedQuery = url.search;
      return Response.json({ verdicts: mockVerdicts });
    },
  });

  let client: Awaited<ReturnType<typeof connectInMemory>> | undefined;
  try {
    const daemon = new DaemonClient({ baseUrl: `http://localhost:${srv.port}`, token: 't' });
    client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: 'reconciler_verdicts',
      arguments: { since: '2026-05-07T00:00:00.000Z', limit: 5, only_unverified: true },
    });

    const parsed = z.object({
      content: z.array(z.object({ type: z.string(), text: z.string() })).min(1),
    }).parse(out);
    const verdicts = JSON.parse(parsed.content[0].text);

    expect(verdicts).toEqual({ verdicts: mockVerdicts });
    expect(receivedPath).toBe('/reconciler/verdicts');
    expect(receivedMethod).toBe('GET');
    expect(receivedQuery).toContain('since=2026-05-07T00%3A00%3A00.000Z');
    expect(receivedQuery).toContain('limit=5');
    expect(receivedQuery).toContain('only_unverified=true');
  } finally {
    await client?.close();
    srv.stop(true);
  }
});
