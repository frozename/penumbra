import { expect, test } from 'bun:test';
import { ClaudeCliAdapter } from '../../src/adapters/claude-cli.js';
import { GeminiCliAdapter } from '../../src/adapters/gemini-cli.js';
import { CodexCliAdapter } from '../../src/adapters/codex-cli.js';
import { OpencodeCliAdapter } from '../../src/adapters/opencode-cli.js';
import { buildAdapter } from '../../src/adapters/registry.js';

test('claude-cli adapter pipes prompt → command → text', async () => {
  const adapter = new ClaudeCliAdapter({ command: 'cat', args: [] });
  const out = await adapter.dispatch({
    prompt: 'hi from test', conversation: { id: 'c', project_id: null },
    config: {}, signal: new AbortController().signal,
  });
  expect(out.text.trim()).toBe('hi from test');
});

test('gemini-cli adapter pipes prompt → command → text', async () => {
  const adapter = new GeminiCliAdapter({ command: 'cat', args: [] });
  const out = await adapter.dispatch({
    prompt: 'hi gemini', conversation: { id: 'c', project_id: null },
    config: {}, signal: new AbortController().signal,
  });
  expect(out.text.trim()).toBe('hi gemini');
});

test('gemini-cli adapter removes Gemini CLI operational noise from final output', async () => {
  const contaminated = [
    'MCP issues detected. Run /mcp list for status.GEMINI_DISPATCH_SMOKE_OK',
    'Export retry time 4989ms exceeds remaining timeout 2447ms, not retrying further.',
    'Export retry time 5000ms exceeds remaining timeout 2245ms, not retrying further.',
    '',
  ].join('\n');
  const adapter = new GeminiCliAdapter({
    command: 'sh',
    args: ['-c', 'printf "%s" "$1"', '--', contaminated],
    pass_via: 'argv',
  });

  const out = await adapter.dispatch({
    prompt: 'unused', conversation: { id: 'c', project_id: null },
    config: {}, signal: new AbortController().signal,
  });
  expect(out.text).toBe('GEMINI_DISPATCH_SMOKE_OK\n');

  const events = [];
  for await (const ev of adapter.dispatchStream({
    prompt: 'unused', conversation: { id: 'c', project_id: null },
    config: {}, signal: new AbortController().signal,
  })) {
    events.push(ev);
  }
  const done = events.at(-1);
  expect(done?.type).toBe('done');
  expect(done && done.type === 'done' ? done.result.text : null).toBe('GEMINI_DISPATCH_SMOKE_OK\n');
});

test('codex-cli adapter pipes prompt → command → text', async () => {
  const adapter = new CodexCliAdapter({ command: 'cat', args: [] });
  const out = await adapter.dispatch({
    prompt: 'hi codex', conversation: { id: 'c', project_id: null },
    config: {}, signal: new AbortController().signal,
  });
  expect(out.text.trim()).toBe('hi codex');
});

test('opencode-cli adapter pipes prompt → command → text', async () => {
  const adapter = new OpencodeCliAdapter({ model: 'gpt-5', command: 'cat', args: [], pass_via: 'stdin' });
  const out = await adapter.dispatch({
    prompt: 'hi opencode', conversation: { id: 'c', project_id: null },
    config: {}, signal: new AbortController().signal,
  });
  expect(out.text.trim()).toBe('hi opencode');
});

test('opencode-cli adapter throws on stderr even with exit code 0', async () => {
  // Simulate a command that prints to stderr and exits 0
  const adapter = new OpencodeCliAdapter({ 
    model: 'bogus', 
    command: 'sh', 
    args: ['-c', 'echo "Error: Model not found: bogus" >&2'],
    pass_via: 'stdin' 
  });
  
  const promise = adapter.dispatch({
    prompt: 'hi', conversation: { id: 'c', project_id: null },
    config: {}, signal: new AbortController().signal,
  });
  
  await expect(promise).rejects.toThrow(/opencode-cli error: Error: Model not found: bogus/);
});

test('registry resolves all four CLI adapters', () => {
  expect(() => buildAdapter('claude-cli', { command: 'cat' })).not.toThrow();
  expect(() => buildAdapter('gemini-cli', { command: 'cat' })).not.toThrow();
  expect(() => buildAdapter('codex-cli',  { command: 'cat' })).not.toThrow();
  expect(() => buildAdapter('opencode-cli', { model: 'gpt-5', command: 'cat' })).not.toThrow();
});
