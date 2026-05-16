import { expect, mock, test } from 'bun:test';
import { createJudgeChat, resolveJudgeConfig } from '../src/services/judge-chat.js';

test('createJudgeChat omits authorization when token is empty', async () => {
  const fetchMock = mock(async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'ok' } }],
  }), { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;

  try {
    const chat = createJudgeChat({ baseUrl: 'http://judge' });
    await chat({ model: 'local', messages: [{ role: 'user', content: 'hi' }] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers).toBeDefined();
    expect(headers).not.toHaveProperty('authorization');
    expect(headers).toMatchObject({ 'content-type': 'application/json' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createJudgeChat includes bearer authorization when token is set', async () => {
  const fetchMock = mock(async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'ok' } }],
  }), { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;

  try {
    const chat = createJudgeChat({ baseUrl: 'http://judge', token: 'secret' });
    await chat({ model: 'local', messages: [{ role: 'user', content: 'hi' }] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer secret',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolveJudgeConfig falls through to local defaults when env is empty', () => {
  const cfg = resolveJudgeConfig({});
  expect(cfg.baseUrl).toBe('http://127.0.0.1:8090');
  expect(cfg.model).toBe('local');
  expect(cfg.token).toBe('');
  expect(cfg.usedDefaultBaseUrl).toBe(true);
  expect(cfg.usedDefaultModel).toBe(true);
});

test('resolveJudgeConfig honors PENUMBRA_JUDGE_* primary env names', () => {
  const cfg = resolveJudgeConfig({
    PENUMBRA_JUDGE_BASE_URL: 'http://judge:9000',
    PENUMBRA_JUDGE_MODEL: 'qwen3-8b',
    PENUMBRA_JUDGE_TOKEN: 't',
  });
  expect(cfg.baseUrl).toBe('http://judge:9000');
  expect(cfg.model).toBe('qwen3-8b');
  expect(cfg.token).toBe('t');
  expect(cfg.usedDefaultBaseUrl).toBe(false);
  expect(cfg.usedDefaultModel).toBe(false);
});

test('resolveJudgeConfig falls back to legacy PENUMBRA_SIRIUS_* + SIRIUS_URL', () => {
  const cfg = resolveJudgeConfig({
    PENUMBRA_SIRIUS_BASE_URL: 'http://legacy:1234',
    PENUMBRA_SIRIUS_MODEL: 'gpt-4o',
    PENUMBRA_SIRIUS_TOKEN: 'legacy-token',
  });
  expect(cfg.baseUrl).toBe('http://legacy:1234');
  expect(cfg.model).toBe('gpt-4o');
  expect(cfg.token).toBe('legacy-token');
  expect(cfg.usedDefaultBaseUrl).toBe(false);
  expect(cfg.usedDefaultModel).toBe(false);
});

test('resolveJudgeConfig prefers PENUMBRA_JUDGE_* over legacy', () => {
  const cfg = resolveJudgeConfig({
    PENUMBRA_JUDGE_BASE_URL: 'http://new',
    PENUMBRA_SIRIUS_BASE_URL: 'http://old',
    SIRIUS_URL: 'http://oldest',
    PENUMBRA_JUDGE_MODEL: 'new-model',
    PENUMBRA_SIRIUS_MODEL: 'old-model',
  });
  expect(cfg.baseUrl).toBe('http://new');
  expect(cfg.model).toBe('new-model');
});

test('resolveJudgeConfig honors extraModelEnv first', () => {
  const cfg = resolveJudgeConfig(
    {
      PENUMBRA_REFINER_MODEL: 'refiner-special',
      PENUMBRA_JUDGE_MODEL: 'judge-default',
    },
    { extraModelEnv: ['PENUMBRA_REFINER_MODEL'] },
  );
  expect(cfg.model).toBe('refiner-special');
});
