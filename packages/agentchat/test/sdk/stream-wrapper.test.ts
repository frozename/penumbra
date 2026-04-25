// packages/agentchat/test/sdk/stream-wrapper.test.ts
import { expect, test } from 'bun:test';
import { ensureDispatchStream } from '../../src/sdk/stream-wrapper.js';
import type { Adapter } from '../../src/sdk/adapter.js';

test('ensureDispatchStream wraps non-streaming dispatch into a single delta + done', async () => {
  const adapter: Adapter = {
    kind: 'fake',
    async dispatch() { return { text: 'hello world' }; },
  };

  const stream = ensureDispatchStream(adapter, {
    prompt: 'p', conversation: { id: 'c', project_id: null }, config: {}, signal: new AbortController().signal,
  });

  const events: any[] = [];
  for await (const ev of stream) events.push(ev);
  expect(events).toEqual([
    { type: 'delta', text: 'hello world' },
    { type: 'done', result: { text: 'hello world' } },
  ]);
});

test('ensureDispatchStream passes through native dispatchStream when present', async () => {
  const adapter: Adapter = {
    kind: 'fake',
    async dispatch() { throw new Error('should not be called'); },
    async *dispatchStream() {
      yield { type: 'delta', text: 'hi ' } as const;
      yield { type: 'delta', text: 'there' } as const;
      yield { type: 'done', result: { text: 'hi there' } } as const;
    },
  };
  const events: any[] = [];
  for await (const ev of ensureDispatchStream(adapter, {
    prompt: 'p', conversation: { id: 'c', project_id: null }, config: {}, signal: new AbortController().signal,
  })) events.push(ev);
  expect(events.length).toBe(3);
  expect(events[0]).toEqual({ type: 'delta', text: 'hi ' });
});
