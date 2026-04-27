import { expect, test, mock } from 'bun:test';
import { DaemonHttpError } from '../../src/daemon-client.js';
import { chainGetResponseHandler, ChainGetResponseInputShape } from '../../src/tools/chain-get-response.js';

test('ChainGetResponseInputShape requires conversation_id', () => {
  expect(() => (ChainGetResponseInputShape as any).conversation_id.parse(undefined)).toThrow();
  expect((ChainGetResponseInputShape as any).which.parse(undefined)).toBe('final');
  expect((ChainGetResponseInputShape as any).which.parse('all')).toBe('all');
});

test('chainGetResponseHandler calls daemon.getChainResponses and formats output', async () => {
  const daemon = {
    getChainResponses: async (conversation_id: string, which: string) => {
      expect(conversation_id).toBe('conv1');
      expect(which).toBe('all');
      return { responses: [{ agent: 'a', text: 'hi', ts: 't' }] };
    },
  } as any;
  const handler = chainGetResponseHandler(daemon);
  const res = await handler({ conversation_id: 'conv1', which: 'all' });
  expect(res.content[0].type).toBe('text');
  expect(JSON.parse(res.content[0].text)).toEqual({
    responses: [{ agent: 'a', text: 'hi', ts: 't' }]
  });
});

test('chainGetResponseHandler preserves multiline text and optional error fields', async () => {
  const daemon = {
    getChainResponses: mock().mockResolvedValue({
      responses: [
        { agent: 'planner', text: 'line1\nline2', ts: 't1' },
        { agent: 'planner', text: '', error: { message: 'adapter crashed' }, ts: 't2' },
      ],
    }),
  } as any;
  const handler = chainGetResponseHandler(daemon);
  const res = await handler({ conversation_id: 'conv1', which: 'all' });
  const parsed = JSON.parse(res.content[0].text);
  expect(parsed.responses[0].text).toBe('line1\nline2');
  expect(parsed.responses[1].error).toEqual({ message: 'adapter crashed' });
});

test('chainGetResponseHandler maps daemon 404s to a structured not_found payload', async () => {
  const err = new DaemonHttpError(
    'daemon /chains/responses: HTTP 404',
    404,
    { error: { code: 'not_found', message: 'no chain events found for conversation' } },
  );
  const daemon = {
    getChainResponses: mock().mockRejectedValue(err),
  } as any;
  const handler = chainGetResponseHandler(daemon);
  const res = await handler({ conversation_id: 'missing', which: 'final' });
  expect(JSON.parse(res.content[0].text)).toEqual({
    error: { code: 'not_found', message: 'no chain events found for conversation' },
  });
});

test('chainGetResponseHandler rethrows non-404 daemon errors', async () => {
  const daemon = {
    getChainResponses: mock().mockRejectedValue(new Error('daemon /chains/responses: HTTP 500')),
  } as any;
  const handler = chainGetResponseHandler(daemon);
  await expect(handler({ conversation_id: 'conv1', which: 'final' })).rejects.toThrow('HTTP 500');
});

test('chainGetResponseHandler rethrows DaemonHttpError 500s instead of masking them as not_found', async () => {
  const err = new DaemonHttpError('test', 500, 'oops');
  const daemon = {
    getChainResponses: mock().mockRejectedValue(err),
  } as any;
  const handler = chainGetResponseHandler(daemon);
  await expect(handler({ conversation_id: 'conv1', which: 'final' })).rejects.toBe(err);
});
