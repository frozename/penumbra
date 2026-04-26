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
