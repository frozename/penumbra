import { expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { DaemonClient } from '../../src/daemon-client.js';
import { DispatchTimelineInputShape, dispatchTimelineHandler } from '../../src/tools/dispatch-timeline.js';
import { connectInMemory } from '../helpers.js';

test('DispatchTimelineInputShape requires a handoff_id string', () => {
  const schema = z.object(DispatchTimelineInputShape);
  expect(() => schema.parse({})).toThrow();
  expect(() => schema.parse({ handoff_id: '' })).toThrow();
  expect(schema.parse({ handoff_id: 'h-1' }).handoff_id).toBe('h-1');
});

test('dispatchTimelineHandler delegates to the daemon and returns JSON text content', async () => {
  const event = {
    kind: 'dispatch.start',
    ts: '2026-05-01T00:00:00Z',
    source: 'worker',
    handoff_id: 'h-1',
    worker_id: 'worker-1',
    meta: null,
  };
  const daemon = {
    getDispatchTimeline: mock(async (handoff_id: string) => ({
      events: [{ ...event, handoff_id }],
    })),
  } as any;

  const result = await dispatchTimelineHandler(daemon)({ handoff_id: 'h-1' });

  expect(daemon.getDispatchTimeline).toHaveBeenCalledWith('h-1');
  expect(result.content[0].type).toBe('text');
  expect(JSON.parse(result.content[0].text)).toEqual({
    events: [event],
  });
});

test('dispatch.timeline is registered and forwards through DaemonClient to GET /dispatch/events', async () => {
  let receivedMethod: string | undefined;
  let receivedPath: string | undefined;
  let receivedHandoffId: string | null = null;
  const timeline = {
    events: [{
      kind: 'dispatch.end',
      ts: '2026-05-01T00:00:01Z',
      source: 'worker',
      handoff_id: 'h space',
      worker_id: 'worker-1',
      meta: { status: 'ok' },
    }],
  };
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      receivedMethod = req.method;
      receivedPath = url.pathname;
      receivedHandoffId = url.searchParams.get('handoff_id');
      return Response.json(timeline);
    },
  });
  let client: Awaited<ReturnType<typeof connectInMemory>> | undefined;

  try {
    const daemon = new DaemonClient({ baseUrl: `http://localhost:${srv.port}`, token: 't' });
    client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: 'dispatch.timeline',
      arguments: { handoff_id: 'h space' },
    });
    const content = (out as unknown as { content: { type: string; text: string }[] }).content;

    expect(JSON.parse(content[0]!.text)).toEqual(timeline);
    expect(receivedMethod).toBe('GET');
    expect(receivedPath).toBe('/dispatch/events');
    expect(receivedHandoffId).toBe('h space');
  } finally {
    await client?.close();
    srv.stop(true);
  }
});
