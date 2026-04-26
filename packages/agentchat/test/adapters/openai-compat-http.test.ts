import { expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { OpenAiCompatHttpAdapter } from '../../src/adapters/openai-compat-http.js';

let originalFetch: typeof fetch;
beforeEach(() => { originalFetch = global.fetch; });
afterEach(() => { global.fetch = originalFetch; });

test('dispatch POSTs to baseUrl/v1/chat/completions and returns text + usage', async () => {
  const calls: any[] = [];
  global.fetch = mock(async (url: any, init: any) => {
    calls.push({ url: url.toString(), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'hi back' } }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }));
  }) as any;

  const adapter = new OpenAiCompatHttpAdapter({
    baseUrl: 'http://example/v1', apiKey: 'tk', model: 'm',
  });
  const out = await adapter.dispatch({
    prompt: 'hi', conversation: { id: 'c', project_id: null }, config: {},
    signal: new AbortController().signal,
  });
  expect(out.text).toBe('hi back');
  expect(out.meta?.tokens_in).toBe(4);
  expect(out.meta?.tokens_out).toBe(2);
  expect(calls[0].url).toBe('http://example/v1/chat/completions');
  expect(calls[0].body.messages[0]).toEqual({ role: 'user', content: 'hi' });
});

test('dispatch falls back to reasoning_content when content is empty', async () => {
  global.fetch = mock(async () => new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'thought it through' } }],
    usage: { prompt_tokens: 1, completion_tokens: 5 },
  }))) as any;
  const adapter = new OpenAiCompatHttpAdapter({ baseUrl: 'http://example/v1', apiKey: 'tk', model: 'm' });
  const out = await adapter.dispatch({
    prompt: 'p', conversation: { id: 'c', project_id: null }, config: {},
    signal: new AbortController().signal,
  });
  expect(out.text).toBe('thought it through');
});

test('dispatch prefers content over reasoning_content when both present', async () => {
  global.fetch = mock(async () => new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'final answer', reasoning_content: 'scratch' } }],
  }))) as any;
  const adapter = new OpenAiCompatHttpAdapter({ baseUrl: 'http://example/v1', apiKey: 'tk', model: 'm' });
  const out = await adapter.dispatch({
    prompt: 'p', conversation: { id: 'c', project_id: null }, config: {},
    signal: new AbortController().signal,
  });
  expect(out.text).toBe('final answer');
});

test('dispatch raises on non-2xx', async () => {
  global.fetch = mock(async () => new Response('boom', { status: 500 })) as any;
  const adapter = new OpenAiCompatHttpAdapter({ baseUrl: 'http://example/v1', apiKey: 'tk', model: 'm' });
  await expect(adapter.dispatch({
    prompt: 'p', conversation: { id: 'c', project_id: null }, config: {},
    signal: new AbortController().signal,
  })).rejects.toThrow(/HTTP 500/);
});
