import { expect, test } from 'bun:test';
import { spawnCliAdapter } from '../../src/adapters/cli-spawn.js';

test('spawnCliAdapter pipes prompt to stdin and returns stdout', async () => {
  const out = await spawnCliAdapter({
    command: 'cat',
    args: [],
    prompt: 'hello\nworld\n',
    signal: new AbortController().signal,
  });
  expect(out.text.trim()).toBe('hello\nworld');
});

test('spawnCliAdapter throws on non-zero exit', async () => {
  await expect(spawnCliAdapter({
    command: 'sh',
    args: ['-c', 'exit 7'],
    prompt: '',
    signal: new AbortController().signal,
  })).rejects.toThrow(/exit code 7/);
});

test('spawnCliAdapter aborts on signal', async () => {
  const ac = new AbortController();
  const p = spawnCliAdapter({
    command: 'sleep', args: ['5'], prompt: '', signal: ac.signal,
  });
  ac.abort();
  await expect(p).rejects.toThrow();
});
