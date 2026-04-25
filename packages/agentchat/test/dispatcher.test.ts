import { expect, test } from 'bun:test';
import { dispatchHandoff } from '../src/dispatcher.js';
import type { Adapter } from '../src/sdk/adapter.js';

test('dispatchHandoff runs the adapter and returns the response text', async () => {
  const calls: any[] = [];
  const adapter: Adapter = {
    kind: 'fake',
    async dispatch(input) {
      calls.push(input);
      return { text: 'response from gemini' };
    },
  };
  const result = await dispatchHandoff({
    adapter,
    prompt: 'go',
    conversation: { id: 'c', project_id: null },
    signal: new AbortController().signal,
    config: {},
  });
  expect(result.text).toBe('response from gemini');
  expect(calls.length).toBe(1);
  expect(calls[0].prompt).toBe('go');
});
