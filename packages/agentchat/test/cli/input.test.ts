import { expect, test } from 'bun:test';
import { parseInputStream } from '../../src/cli/input.js';

async function toArray<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
  }
  return out;
}

test('two single-line messages separated by blank lines', async () => {
  const input = (async function* () {
    yield 'hello\n';
    yield '\n';
    yield 'world\n';
    yield '\n';
  })();
  const events = await toArray(parseInputStream(input));
  expect(events).toEqual([
    { kind: 'message', text: 'hello' },
    { kind: 'message', text: 'world' }
  ]);
});

test('one 3-line message followed by blank', async () => {
  const input = (async function* () {
    yield 'line 1\n';
    yield 'line 2\n';
    yield 'line 3\n';
    yield '\n';
  })();
  const events = await toArray(parseInputStream(input));
  expect(events).toEqual([
    { kind: 'message', text: 'line 1\nline 2\nline 3' }
  ]);
});

test('a line done on its own emits done event', async () => {
  const input = (async function* () {
    yield 'done\n';
  })();
  const events = await toArray(parseInputStream(input));
  expect(events).toEqual([{ kind: 'done' }]);
});

test('stream ends with content in buffer emits final message', async () => {
  const input = (async function* () {
    yield 'final message\n';
  })();
  const events = await toArray(parseInputStream(input));
  expect(events).toEqual([{ kind: 'message', text: 'final message' }]);
});

test('single message followed by done emits exactly one message event', async () => {
  async function* lines() { yield 'hello'; yield ''; yield 'done'; }
  const iter = lines()[Symbol.asyncIterator]();
  const events: any[] = [];
  for await (const ev of parseInputStream(iter)) events.push(ev);
  expect(events).toEqual([{ kind: 'message', text: 'hello' }, { kind: 'done' }]);
});

test('parseInputStream does not re-emit messages after the for-await body resumes', async () => {
  async function* lines() { yield 'msg one'; yield ''; yield 'approval-line'; yield 'done'; }
  const iter = lines()[Symbol.asyncIterator]();
  let messageCount = 0;
  for await (const ev of parseInputStream(iter)) {
    if (ev.kind === 'message') {
      messageCount++;
      const { value } = await iter.next();
      expect(value).toBe('approval-line');
    }
    if (ev.kind === 'done') break;
  }
  expect(messageCount).toBe(1);
});

