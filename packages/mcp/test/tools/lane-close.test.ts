import { expect, test } from 'bun:test';
import { z } from 'zod';
import { DaemonClient } from '../../src/daemon-client.js';
import { LaneCloseInputShape, laneCloseHandler } from '../../src/tools/lane-close.js';

function makeDaemon(fetchImpl: typeof fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const daemon = new DaemonClient({ baseUrl: 'http://daemon', token: 't' });
  return {
    daemon,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test('LaneCloseInputShape requires a closing gate status', () => {
  const schema = z.object(LaneCloseInputShape);
  expect(() => schema.parse({ lane_id: 'lane-1', gate_status: 'open' })).toThrow();
  expect(() => schema.parse({ lane_id: '', gate_status: 'passed' })).toThrow();
  expect(schema.parse({ lane_id: 'lane-1', gate_status: 'failed' })).toEqual({
    lane_id: 'lane-1',
    gate_status: 'failed',
  });
});

test('laneCloseHandler posts lane_close to the daemon and returns the response', async () => {
  let receivedMethod: string | undefined;
  let receivedPath: string | undefined;
  let receivedAuth: string | undefined;
  let receivedBody: unknown;
  const { daemon, restore } = makeDaemon(async (input, init) => {
    receivedMethod = init?.method;
    receivedPath = new URL(String(input)).pathname;
    receivedAuth = init?.headers ? new Headers(init.headers as HeadersInit).get('authorization') ?? undefined : undefined;
    receivedBody = JSON.parse(String(init?.body));
    return Response.json({ lane_id: 'lane-1234', gate_status: 'passed', ts_closed: '2026-05-12T00:00:00Z' });
  });

  try {
    const out = await laneCloseHandler(daemon)({
      lane_id: 'lane-1234',
      gate_status: 'passed',
      reviewer_handoff_id: 'reviewer-1',
      override_reason: 'validated in review',
    });

    expect(receivedMethod).toBe('POST');
    expect(receivedPath).toBe('/lanes/close');
    expect(receivedAuth).toBe('Bearer t');
    expect(receivedBody).toEqual({
      lane_id: 'lane-1234',
      gate_status: 'passed',
      reviewer_handoff_id: 'reviewer-1',
      override_reason: 'validated in review',
    });
    expect(out).toEqual({
      lane_id: 'lane-1234',
      gate_status: 'passed',
      ts_closed: '2026-05-12T00:00:00Z',
    });
  } finally {
    restore();
  }
});

test('laneCloseHandler surfaces daemon 400 errors', async () => {
  const { daemon, restore } = makeDaemon(async () => new Response(JSON.stringify({ error: { code: 'validation_failed' } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    await expect(
      laneCloseHandler(daemon)({ lane_id: 'lane-1234', gate_status: 'failed' }),
    ).rejects.toThrow('daemon /lanes/close: HTTP 400');
  } finally {
    restore();
  }
});
