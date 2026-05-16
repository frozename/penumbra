import { expect, mock, test } from 'bun:test';
import { createJudgeChat } from '../src/services/judge-chat.js';

test('createJudgeChat omits authorization when token is empty', async () => {
  const fetchMock = mock(async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'ok' } }],
  }), { status: 200 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;

  try {
    const chat = createJudgeChat({ baseUrl: 'http://judge', model: 'local' });
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
    const chat = createJudgeChat({ baseUrl: 'http://judge', model: 'local', token: 'secret' });
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
