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

test('mode=whole concatenates all lines as a single message regardless of blank lines', async () => {
  async function* lines() {
    yield 'paragraph 1';
    yield '';
    yield 'paragraph 2 line a';
    yield 'paragraph 2 line b';
    yield '';
    yield 'paragraph 3';
  }
  const events: any[] = [];
  for await (const ev of parseInputStream(lines()[Symbol.asyncIterator](), { mode: 'whole' })) {
    events.push(ev);
  }
  expect(events).toEqual([
    { kind: 'message', text: 'paragraph 1\n\nparagraph 2 line a\nparagraph 2 line b\n\nparagraph 3' },
    { kind: 'done' },
  ]);
});

test('mode=whole does not treat a literal "done" line as the done sentinel', async () => {
  async function* lines() {
    yield 'instructions follow:';
    yield 'done';
    yield 'final word';
  }
  const events: any[] = [];
  for await (const ev of parseInputStream(lines()[Symbol.asyncIterator](), { mode: 'whole' })) {
    events.push(ev);
  }
  expect(events).toEqual([
    { kind: 'message', text: 'instructions follow:\ndone\nfinal word' },
    { kind: 'done' },
  ]);
});

test('mode=whole emits done with no message when input is empty', async () => {
  async function* lines() { /* yields nothing */ }
  const events: any[] = [];
  for await (const ev of parseInputStream(lines()[Symbol.asyncIterator](), { mode: 'whole' })) {
    events.push(ev);
  }
  expect(events).toEqual([{ kind: 'done' }]);
});

test('default mode is split (back-compat with existing callers)', async () => {
  async function* lines() {
    yield 'paragraph 1';
    yield '';
    yield 'paragraph 2';
    yield '';
  }
  const events: any[] = [];
  for await (const ev of parseInputStream(lines()[Symbol.asyncIterator]())) {
    events.push(ev);
  }
  expect(events).toEqual([
    { kind: 'message', text: 'paragraph 1' },
    { kind: 'message', text: 'paragraph 2' },
  ]);
});

