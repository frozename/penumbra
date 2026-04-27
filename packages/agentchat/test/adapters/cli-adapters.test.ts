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

test('registry resolves all four CLI adapters', () => {
  expect(() => buildAdapter('claude-cli', { command: 'cat' })).not.toThrow();
  expect(() => buildAdapter('gemini-cli', { command: 'cat' })).not.toThrow();
  expect(() => buildAdapter('codex-cli',  { command: 'cat' })).not.toThrow();
  expect(() => buildAdapter('opencode-cli', { model: 'gpt-5', command: 'cat' })).not.toThrow();
});
