import { expect, test, describe } from 'bun:test';
import { Test } from '@nestjs/testing';
import { Controller, Post, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PenumbraObserveInterceptor } from '../src/interceptor.js';
import { PENUMBRA_CONFIG, PENUMBRA_DAEMON_CLIENT } from '../src/tokens.js';
import type { T0EventInput } from '@penumbra/core';

interface CapturedCall { event: T0EventInput }

function makeFakeClient(): {
  observed: CapturedCall[];
  client: { observe: (e: T0EventInput) => Promise<void> };
} {
  const observed: CapturedCall[] = [];
  return {
    observed,
    client: { async observe(event: T0EventInput) { observed.push({ event }); } },
  };
}

@Controller()
class StreamingController {
  @Post('v1/chat/completions')
  chat(): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(enc.encode('data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n'));
        ctrl.enqueue(enc.encode('data: {"choices":[{"index":0,"delta":{"content":" world"}}]}\n\n'));
        ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
        ctrl.close();
      },
    });
  }
}

async function buildApp(client: { observe: (e: T0EventInput) => Promise<void> }) {
  @Module({
    controllers: [StreamingController],
    providers: [
      {
        provide: PENUMBRA_CONFIG,
        useValue: { kind: 'enabled', baseUrl: 'http://x', token: 'tk', machineId: 'host-1' },
      },
      { provide: PENUMBRA_DAEMON_CLIENT, useValue: client },
      { provide: APP_INTERCEPTOR, useClass: PenumbraObserveInterceptor },
    ],
  })
  class TestAppModule {}

  const m = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
  const app = m.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((r) => queueMicrotask(r));
  await new Promise<void>((r) => setTimeout(r, 10));
}

describe('PenumbraObserveInterceptor (streamed)', () => {
  test('streamed response → observations fire after stream end with concatenated text', async () => {
    const fc = makeFakeClient();
    const app = await buildApp(fc.client);
    try {
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'x-penumbra-project': 'p1' },
        payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
      });
      expect(res.statusCode).toBe(201);
      await flushMicrotasks();
      expect(fc.observed).toHaveLength(2);
      const responseEvent = fc.observed.find((c) => c.event.event_type === 'agent-response');
      expect(responseEvent).toBeDefined();
      expect(responseEvent!.event.payload_summary).toBe('hello world');
    } finally { await app.close(); }
  });
});
