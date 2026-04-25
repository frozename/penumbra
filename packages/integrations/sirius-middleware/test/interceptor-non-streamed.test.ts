import { expect, test, describe, beforeEach } from 'bun:test';
import { Test } from '@nestjs/testing';
import { Controller, Post, Body, Headers, Module } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PenumbraObserveInterceptor } from '../src/interceptor.js';
import { PENUMBRA_CONFIG, PENUMBRA_DAEMON_CLIENT } from '../src/tokens.js';
import type { T0EventInput } from '@penumbra/core';

interface CapturedCall { event: T0EventInput }
function makeFakeClient(): { observed: CapturedCall[]; reject: boolean; client: { observe: (e: T0EventInput) => Promise<void> } } {
  const state = { observed: [] as CapturedCall[], reject: false };
  const client = {
    async observe(event: T0EventInput) {
      if (state.reject) throw new Error('fake daemon down');
      state.observed.push({ event });
    },
  };
  return { ...state, client, get observed() { return state.observed; }, set reject(v: boolean) { state.reject = v; } } as unknown as {
    observed: CapturedCall[]; reject: boolean; client: { observe: (e: T0EventInput) => Promise<void> };
  };
}

@Controller()
class FakeController {
  @Post('v1/chat/completions')
  chat(@Body() body: unknown, @Headers() headers: Record<string, string>): unknown {
    void headers; void body;
    return {
      model: 'gpt-4o-mini',
      provider: 'openai',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi back' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    };
  }

  @Post('v1/embeddings')
  embed(): unknown {
    return { data: [] };
  }

  @Post('health')
  health(): { ok: true } {
    return { ok: true };
  }
}

async function buildApp(opts: { configEnabled: boolean; client: { observe: (e: T0EventInput) => Promise<void> } }) {
  @Module({
    controllers: [FakeController],
    providers: [
      {
        provide: PENUMBRA_CONFIG,
        useValue: opts.configEnabled
          ? { kind: 'enabled', baseUrl: 'http://x', token: 'tk', machineId: 'host-1' }
          : { kind: 'disabled', reason: 'test' },
      },
      { provide: PENUMBRA_DAEMON_CLIENT, useValue: opts.client },
      { provide: APP_INTERCEPTOR, useClass: PenumbraObserveInterceptor },
    ],
  })
  class TestAppModule {}

  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

async function flushMicrotasks(): Promise<void> {
  // Two ticks: outer queueMicrotask schedules the POST; inner one resolves it.
  await new Promise<void>((r) => queueMicrotask(r));
  await new Promise<void>((r) => setTimeout(r, 0));
}

describe('PenumbraObserveInterceptor (non-streamed)', () => {
  test('header missing → no observe call', async () => {
    const fc = makeFakeClient();
    const app = await buildApp({ configEnabled: true, client: fc.client });
    try {
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        payload: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.statusCode).toBe(201);
      await flushMicrotasks();
      expect(fc.observed).toHaveLength(0);
    } finally { await app.close(); }
  });

  test('embeddings route + header → no observe call (loop guard)', async () => {
    const fc = makeFakeClient();
    const app = await buildApp({ configEnabled: true, client: fc.client });
    try {
      await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/v1/embeddings',
        headers: { 'content-type': 'application/json', 'x-penumbra-project': 'p1' },
        payload: { input: 'x' },
      });
      await flushMicrotasks();
      expect(fc.observed).toHaveLength(0);
    } finally { await app.close(); }
  });

  test('non-chat route + header → no observe call', async () => {
    const fc = makeFakeClient();
    const app = await buildApp({ configEnabled: true, client: fc.client });
    try {
      await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/health',
        headers: { 'content-type': 'application/json', 'x-penumbra-project': 'p1' },
        payload: {},
      });
      await flushMicrotasks();
      expect(fc.observed).toHaveLength(0);
    } finally { await app.close(); }
  });

  test('chat + header → exactly two observe calls (prompt + response) sharing session_id', async () => {
    const fc = makeFakeClient();
    const app = await buildApp({ configEnabled: true, client: fc.client });
    try {
      await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          'x-penumbra-project': 'proj-1',
          'x-penumbra-user': 'alice',
          'x-request-id': 'req-abc',
        },
        payload: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      });
      await flushMicrotasks();
      expect(fc.observed).toHaveLength(2);
      const [first, second] = fc.observed;
      expect(first!.event.event_type).toBe('agent-prompt');
      expect(second!.event.event_type).toBe('agent-response');
      expect(first!.event.session_id).toBe('req-abc');
      expect(second!.event.session_id).toBe('req-abc');
      expect(first!.event.user_id).toBe('alice');
      expect(second!.event.tokens_in).toBe(3);
      expect(second!.event.tokens_out).toBe(2);
      expect(second!.event.payload_summary).toBe('hi back');
    } finally { await app.close(); }
  });

  test('user header missing → user_id falls back to "anonymous"', async () => {
    const fc = makeFakeClient();
    const app = await buildApp({ configEnabled: true, client: fc.client });
    try {
      await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'x-penumbra-project': 'p' },
        payload: { model: 'm', messages: [{ role: 'user', content: 'q' }] },
      });
      await flushMicrotasks();
      expect(fc.observed[0]!.event.user_id).toBe('anonymous');
      expect(fc.observed[1]!.event.user_id).toBe('anonymous');
    } finally { await app.close(); }
  });

  test('request-id header missing → generated UUID is shared across both events', async () => {
    const fc = makeFakeClient();
    const app = await buildApp({ configEnabled: true, client: fc.client });
    try {
      await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'x-penumbra-project': 'p' },
        payload: { model: 'm', messages: [{ role: 'user', content: 'q' }] },
      });
      await flushMicrotasks();
      expect(fc.observed).toHaveLength(2);
      expect(fc.observed[0]!.event.session_id).toEqual(fc.observed[1]!.event.session_id);
      expect(fc.observed[0]!.event.session_id).toMatch(/^[0-9a-f-]{36}$/);
    } finally { await app.close(); }
  });

  test('config disabled → no observe call ever', async () => {
    const fc = makeFakeClient();
    const app = await buildApp({ configEnabled: false, client: fc.client });
    try {
      await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'x-penumbra-project': 'p' },
        payload: { model: 'm', messages: [{ role: 'user', content: 'q' }] },
      });
      await flushMicrotasks();
      expect(fc.observed).toHaveLength(0);
    } finally { await app.close(); }
  });

  test('daemon client rejects → caller still gets the response, no exception bubbles', async () => {
    const fc = makeFakeClient();
    fc.reject = true;
    const app = await buildApp({ configEnabled: true, client: fc.client });
    try {
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'x-penumbra-project': 'p' },
        payload: { model: 'm', messages: [{ role: 'user', content: 'q' }] },
      });
      expect(res.statusCode).toBe(201);
      await flushMicrotasks();
      // Failures are silent — we only assert the response wasn't broken.
    } finally { await app.close(); }
  });
});
