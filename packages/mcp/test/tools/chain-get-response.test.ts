import { expect, test } from 'bun:test';
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
