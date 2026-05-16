import { describe, expect, it, test } from 'bun:test';
import { z } from 'zod';
import { connectInMemory } from './helpers.js';
import { DaemonClient } from '../src/daemon-client.js';
import { ObserveInputShape } from '../src/tools/observe.js';

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

describe('ObserveInputShape task-draft lifecycle variants', () => {
  const schema = z.object(ObserveInputShape).strict();
  const variants = [
    'task_draft',
    'task_draft_refining',
    'task_draft_promoted',
    'task_draft_stale',
    'task_draft_duplicate',
    'task_draft_escalation',
  ] as const;
  for (const v of variants) {
    it(`accepts event_type=${v}`, () => {
      const parsed = schema.parse({
        ts: '2026-05-16T00:00:00Z',
        source: 'mcp',
        event_type: v,
        lane: 'unknown',
        payload_json: { draft_id: 'd-1' },
      });
      expect(parsed.event_type).toBe(v);
    });
  }
});
