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

test('spawnCliAdapter passes prompt via argv when configured', async () => {
  const out = await spawnCliAdapter({
    command: 'sh',
    args: ['-c', 'echo "$1"', '--'],
    prompt: 'hello via argv',
    signal: new AbortController().signal,
    pass_via: 'argv',
  });
  expect(out.text.trim()).toBe('hello via argv');
});

test('spawnCliAdapter throws on non-zero exit', async () => {
  await expect(spawnCliAdapter({
    command: 'sh',
    args: ['-c', 'exit 7'],
    prompt: '',
    signal: new AbortController().signal,
  })).rejects.toThrow(/exit code 7/);
});

test('spawnCliAdapter removes inherited env vars listed in unset_env', async () => {
  process.env.AGENTCHAT_TEST_VAR = 'should-be-gone';
  try {
    const withVar = await spawnCliAdapter({
      command: 'sh',
      args: ['-c', 'printf %s "${AGENTCHAT_TEST_VAR-MISSING}"'],
      prompt: '',
      signal: new AbortController().signal,
    });
    expect(withVar.text).toBe('should-be-gone');

    const withoutVar = await spawnCliAdapter({
      command: 'sh',
      args: ['-c', 'printf %s "${AGENTCHAT_TEST_VAR-MISSING}"'],
      prompt: '',
      signal: new AbortController().signal,
      unset_env: ['AGENTCHAT_TEST_VAR'],
    });
    expect(withoutVar.text).toBe('MISSING');
  } finally {
    delete process.env.AGENTCHAT_TEST_VAR;
  }
});

test('spawnCliAdapter strips lines matching strip_patterns regexes from output', async () => {
  const out = await spawnCliAdapter({
    command: 'sh',
    args: ['-c', 'printf "hook: SessionStart\\nMODEL_REPLY_OK\\nhook: Stop\\n"'],
    prompt: '',
    signal: new AbortController().signal,
    strip_patterns: ['^hook: .*$'],
  });
  expect(out.text.trim()).toBe('MODEL_REPLY_OK');
});

test('spawnCliAdapter without strip_patterns leaves output untouched', async () => {
  const out = await spawnCliAdapter({
    command: 'sh',
    args: ['-c', 'printf "line one\\nline two\\n"'],
    prompt: '',
    signal: new AbortController().signal,
  });
  expect(out.text).toBe('line one\nline two\n');
});

test('spawnCliAdapter aborts on signal', async () => {
  const ac = new AbortController();
  const p = spawnCliAdapter({
    command: 'sleep', args: ['5'], prompt: '', signal: ac.signal,
  });
  ac.abort();
  await expect(p).rejects.toThrow();
});

test('spawnCliAdapter escalates from SIGTERM to SIGKILL after the cancel grace', async () => {
  const ac = new AbortController();
  const p = spawnCliAdapter({
    command: 'sh',
    args: ['-c', 'trap "" TERM; while :; do sleep 1; done'],
    prompt: '',
    signal: ac.signal,
    env: { PENUMBRA_CANCEL_GRACE_S: '0.05' },
  });
  ac.abort();
  await expect(p).rejects.toThrow();
});
