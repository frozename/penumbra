import { expect, test, mock } from 'bun:test';
import { DaemonHttpError } from '../../src/daemon-client.js';
import { handoffGetHandler, HandoffGetInputShape } from '../../src/tools/handoff-get.js';

test('HandoffGetInputShape requires handoff_id', () => {
  expect(() => (HandoffGetInputShape as any).handoff_id.parse(undefined)).toThrow();
  expect((HandoffGetInputShape as any).handoff_id.parse('h1')).toBe('h1');
});

test('handoffGetHandler calls daemon.getHandoff and formats output', async () => {
  const handoffFixture = {
    handoff_id: 'h1',
    status: 'completed',
    error_message: null,
    worker_id: 'w1',
    resolved_at: '2026-04-26T20:00:00Z',
    resolution_reason: 'done',
    ts: '2026-04-26T19:00:00Z',
    conversation_id: 'c1',
    from_agent: 'user',
    to_agent: 'agent',
  };
  const daemon = {
    getHandoff: async (handoff_id: string) => {
      expect(handoff_id).toBe('h1');
      return { handoff: handoffFixture };
    },
  } as any;
  const handler = handoffGetHandler(daemon);
  const res = await handler({ handoff_id: 'h1' });
  expect(res.content[0].type).toBe('text');
  expect(JSON.parse(res.content[0].text)).toEqual({
    handoff: handoffFixture
  });
});

test('handoffGetHandler maps daemon 404s to a structured not_found payload', async () => {
  const err = new DaemonHttpError(
    'daemon /handoffs/missing: HTTP 404',
    404,
    { error: { code: 'not_found', message: 'handoff missing not found' } },
  );
  const daemon = {
    getHandoff: mock().mockRejectedValue(err),
  } as any;
  const handler = handoffGetHandler(daemon);
  const res = await handler({ handoff_id: 'missing' });
  expect(JSON.parse(res.content[0].text)).toEqual({
    error: { code: 'not_found', message: 'handoff missing not found' },
  });
});

test('handoffGetHandler surfaces error_message for failed handoffs', async () => {
  const handoffFixture = {
    handoff_id: 'h2',
    status: 'failed',
    error_message: 'something went wrong',
    worker_id: 'w1',
    resolved_at: '2026-04-26T20:00:00Z',
    resolution_reason: null,
    ts: '2026-04-26T19:00:00Z',
    conversation_id: 'c1',
    from_agent: 'user',
    to_agent: 'agent',
  };
  const daemon = {
    getHandoff: mock().mockResolvedValue({ handoff: handoffFixture }),
  } as any;
  const handler = handoffGetHandler(daemon);
  const res = await handler({ handoff_id: 'h2' });
  const parsed = JSON.parse(res.content[0].text);
  expect(parsed.handoff.error_message).toBe('something went wrong');
});

test('handoffGetHandler rethrows non-404 daemon errors', async () => {
  const daemon = {
    getHandoff: mock().mockRejectedValue(new Error('daemon /handoffs/h1: HTTP 500')),
  } as any;
  const handler = handoffGetHandler(daemon);
  await expect(handler({ handoff_id: 'h1' })).rejects.toThrow('HTTP 500');
});

test('handoffGetHandler rethrows DaemonHttpError 500s instead of masking them as not_found', async () => {
  const err = new DaemonHttpError('test', 500, 'oops');
  const daemon = {
    getHandoff: mock().mockRejectedValue(err),
  } as any;
  const handler = handoffGetHandler(daemon);
  await expect(handler({ handoff_id: 'h1' })).rejects.toBe(err);
});
