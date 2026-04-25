import { expect, test, describe, mock } from 'bun:test';
import Fastify from 'fastify';
import { penumbraObservePlugin } from '../src/plugin.js';
import { Readable } from 'node:stream';

describe('penumbraObservePlugin init', () => {
  test('logs compliant spec message when disabled', async () => {
    let logged = false;
    let loggedObj: any = null;
    const fastify = Fastify();
    await fastify.register(penumbraObservePlugin, {
      logger: { warn: () => {}, info: (obj: any) => {
        if (obj.msg === 'penumbra middleware disabled') {
            logged = true;
            loggedObj = obj;
        }
      }} as any,
    });
    expect(logged).toBe(true);
    expect(loggedObj).toBeDefined();
    expect(loggedObj.PENUMBRA_DAEMON_URL_present).toBe(false);
    expect(loggedObj.PENUMBRA_DAEMON_TOKEN_present).toBe(false);
  });
});

describe('penumbraObservePlugin execution', () => {
  test('captures standard response with payload_summary and tokens_out', async () => {
    const fastify = Fastify();
    const mockFetch = mock((url: string | URL | Request, init?: RequestInit) => {
      return new Response(JSON.stringify({ status: 'ok' }));
    });
    global.fetch = mockFetch as any;

    await fastify.register(penumbraObservePlugin, {
      baseUrl: 'http://mock-daemon',
      token: 'fake-token',
      logger: { warn: () => {}, info: () => {} } as any,
    });

    fastify.post('/v1/chat/completions', async (req, reply) => {
      return {
        id: 'chatcmpl-123',
        model: 'gpt-3.5-turbo',
        choices: [
          { message: { role: 'assistant', content: 'Hello from agent' } }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30
        }
      };
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-penumbra-project': 'test-project',
        'x-request-id': 'req-123'
      },
      payload: {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'Say hello' }]
      }
    });

    expect(response.statusCode).toBe(200);

    // wait for microtasks
    await new Promise(r => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalled();
    const calls = mockFetch.mock.calls;
    expect(calls.length).toBe(2);

    const promptCallUrl = calls[0][0] as string;
    const promptCallOptions = calls[0][1] as any;
    const responseCallUrl = calls[1][0] as string;
    const responseCallOptions = calls[1][1] as any;
    
    expect(promptCallUrl).toBe('http://mock-daemon/observations');
    const promptBody = JSON.parse(promptCallOptions.body);
    expect(promptBody.event_type).toBe('agent-prompt');
    expect(promptBody.payload_summary).toBe('Say hello');
    
    const responseBody = JSON.parse(responseCallOptions.body);
    expect(responseBody.event_type).toBe('agent-response');
    expect(responseBody.payload_summary).toBe('Hello from agent');
    expect(responseBody.tokens_out).toBe(20);
    expect(responseBody.model).toBe('gpt-3.5-turbo');
  });

  test('captures streaming response with payload_summary', async () => {
    const fastify = Fastify();
    const mockFetch = mock((url: string | URL | Request, init?: RequestInit) => {
      return new Response(JSON.stringify({ status: 'ok' }));
    });
    global.fetch = mockFetch as any;

    await fastify.register(penumbraObservePlugin, {
      baseUrl: 'http://mock-daemon',
      token: 'fake-token',
      logger: { warn: () => {}, info: () => {} } as any,
    });

    fastify.post('/v1/chat/completions', async (req, reply) => {
      const stream = new Readable({
        read() {
          this.push('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
          this.push('data: {"choices":[{"delta":{"content":"streaming "}}]}\n\n');
          this.push('data: {"choices":[{"delta":{"content":"agent"}}]}\n\n');
          this.push('data: [DONE]\n\n');
          this.push(null);
        }
      });
      reply.type('text/event-stream');
      return reply.send(stream);
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-penumbra-project': 'test-project',
        'x-request-id': 'req-stream-123'
      },
      payload: {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'Say hello streaming' }]
      }
    });

    expect(response.statusCode).toBe(200);

    // wait for microtasks
    await new Promise(r => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalled();
    const calls = mockFetch.mock.calls;
    
    // first call is prompt, second is response
    const responseCallOptions = calls[calls.length - 1][1] as any;
    const responseBody = JSON.parse(responseCallOptions.body);
    
    expect(responseBody.event_type).toBe('agent-response');
    expect(responseBody.payload_summary).toBe('Hello streaming agent');
    expect(responseBody.model).toBe('gpt-3.5-turbo'); // derived from prompt model
  });

  test('captures streaming response usage when upstream emits a final usage chunk', async () => {
    const fastify = Fastify();
    const mockFetch = mock((url: string | URL | Request, init?: RequestInit) => {
      return new Response(JSON.stringify({ status: 'ok' }));
    });
    global.fetch = mockFetch as any;

    await fastify.register(penumbraObservePlugin, {
      baseUrl: 'http://mock-daemon',
      token: 'fake-token',
      logger: { warn: () => {}, info: () => {} } as any,
    });

    fastify.post('/v1/chat/completions', async (req, reply) => {
      const stream = new Readable({
        read() {
          this.push('data: {"choices":[{"delta":{"content":"Hi "}}],"model":"local"}\n\n');
          this.push('data: {"choices":[{"delta":{"content":"there"}}],"model":"local"}\n\n');
          this.push('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15},"model":"local"}\n\n');
          this.push('data: [DONE]\n\n');
          this.push(null);
        }
      });
      reply.type('text/event-stream');
      return reply.send(stream);
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-penumbra-project': 'test-project',
        'x-request-id': 'req-usage-123'
      },
      payload: {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'Hi back' }]
      }
    });

    expect(response.statusCode).toBe(200);
    await new Promise(r => setTimeout(r, 10));

    const calls = mockFetch.mock.calls;
    const responseBody = JSON.parse((calls[calls.length - 1][1] as any).body);

    expect(responseBody.event_type).toBe('agent-response');
    expect(responseBody.payload_summary).toBe('Hi there');
    expect(responseBody.tokens_in).toBe(11);
    expect(responseBody.tokens_out).toBe(4);
    expect(responseBody.model).toBe('gpt-3.5-turbo'); // prompt's model wins for correlation
  });

  test('reply.penumbraTapChunk + penumbraTapEnd captures raw-socket streaming responses', async () => {
    const fastify = Fastify();
    const mockFetch = mock((_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ status: 'ok' }));
    });
    global.fetch = mockFetch as any;

    await fastify.register(penumbraObservePlugin, {
      baseUrl: 'http://mock-daemon',
      token: 'fake-token',
      logger: { warn: () => {}, info: () => {} } as any,
    });

    fastify.post('/v1/chat/completions', async (req, reply) => {
      // simulate a controller that writes to res.raw and taps the plugin per chunk
      const tap = (reply as any).penumbraTapChunk?.bind(reply);
      const end = (reply as any).penumbraTapEnd?.bind(reply);
      tap?.('data: {"choices":[{"delta":{"content":"Tap "}}]}\n\n');
      tap?.('data: {"choices":[{"delta":{"content":"works"}}],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n');
      tap?.('data: [DONE]\n\n');
      end?.();
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
      reply.raw.end();
    });

    await fastify.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-penumbra-project': 'test-project',
        'x-request-id': 'req-tap-1',
      },
      payload: { model: 'gpt-3.5-turbo', messages: [{ role: 'user', content: 'tap me' }] },
    });
    await new Promise(r => setTimeout(r, 10));

    const calls = mockFetch.mock.calls;
    const responseBody = JSON.parse((calls[calls.length - 1][1] as any).body);
    expect(responseBody.event_type).toBe('agent-response');
    expect(responseBody.payload_summary).toBe('Tap works');
    expect(responseBody.tokens_in).toBe(9);
    expect(responseBody.tokens_out).toBe(2);
    expect(responseBody.model).toBe('gpt-3.5-turbo');
  });

  test('skips agent-response observation when reply status is >= 400', async () => {
    const fastify = Fastify();
    const mockFetch = mock((_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ status: 'ok' }));
    });
    global.fetch = mockFetch as any;

    await fastify.register(penumbraObservePlugin, {
      baseUrl: 'http://mock-daemon',
      token: 'fake-token',
      logger: { warn: () => {}, info: () => {} } as any,
    });

    fastify.post('/v1/chat/completions', async (_req, reply) => {
      reply.code(404);
      return { error: { message: 'model not found' } };
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-penumbra-project': 'test-project', 'x-request-id': 'req-404' },
      payload: { model: 'missing-model', messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(response.statusCode).toBe(404);
    await new Promise(r => setTimeout(r, 10));

    // Only the prompt observation should have fired — no response observation on error.
    const eventTypes = mockFetch.mock.calls.map(c => JSON.parse((c[1] as any).body).event_type);
    expect(eventTypes).toEqual(['agent-prompt']);
  });

  test('agent-response model is the prompt input model, not the upstream echo', async () => {
    const fastify = Fastify();
    const mockFetch = mock((_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ status: 'ok' }));
    });
    global.fetch = mockFetch as any;

    await fastify.register(penumbraObservePlugin, {
      baseUrl: 'http://mock-daemon',
      token: 'fake-token',
      logger: { warn: () => {}, info: () => {} } as any,
    });

    fastify.post('/v1/chat/completions', async () => ({
      // upstream echoes a different model id (e.g. llamactl-agent returns "local")
      model: 'local',
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }));

    await fastify.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-penumbra-project': 'test-project', 'x-request-id': 'req-modelid' },
      payload: { model: 'canonical-model-id', messages: [{ role: 'user', content: 'hi' }] },
    });
    await new Promise(r => setTimeout(r, 10));

    const calls = mockFetch.mock.calls;
    const responseBody = JSON.parse((calls[calls.length - 1][1] as any).body);
    expect(responseBody.event_type).toBe('agent-response');
    expect(responseBody.model).toBe('canonical-model-id');
  });

  test('warn log includes cumulative dropped count after a failed observation', async () => {
    const fastify = Fastify();
    const mockFetch = mock((_url: string | URL | Request, _init?: RequestInit) => {
      throw new Error('Simulated network failure');
    });
    global.fetch = mockFetch as any;

    const warnings: any[] = [];
    await fastify.register(penumbraObservePlugin, {
      baseUrl: 'http://mock-daemon',
      token: 'fake-token',
      logger: {
        warn: (obj: any) => warnings.push(obj),
        info: () => {},
      } as any,
    });

    fastify.post('/v1/chat/completions', async () => ({
      choices: [{ message: { role: 'assistant', content: 'x' } }],
    }));

    await fastify.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-penumbra-project': 'test-project',
        'x-request-id': 'req-drop-1',
      },
      payload: { model: 'gpt-3.5-turbo', messages: [{ role: 'user', content: 'hi' }] },
    });
    await new Promise(r => setTimeout(r, 10));

    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const last = warnings[warnings.length - 1];
    expect(typeof last.dropped_observations_total).toBe('number');
    expect(last.dropped_observations_total).toBeGreaterThanOrEqual(1);
  });

  test('captures agent-response even if agent-prompt fails (disjoint failure)', async () => {
    const fastify = Fastify();
    const mockFetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const parsedBody = init?.body ? JSON.parse(init.body as string) : {};
      if (parsedBody.event_type === 'agent-prompt') {
        throw new Error('Simulated network failure for prompt');
      }
      return new Response(JSON.stringify({ status: 'ok' }));
    });
    global.fetch = mockFetch as any;

    let warningLogged = false;
    await fastify.register(penumbraObservePlugin, {
      baseUrl: 'http://mock-daemon',
      token: 'fake-token',
      logger: { 
        warn: (msg: any) => { warningLogged = true; }, 
        info: () => {} 
      } as any,
    });

    fastify.post('/v1/chat/completions', async (req, reply) => {
      return {
        id: 'chatcmpl-456',
        model: 'gpt-4',
        choices: [
          { message: { role: 'assistant', content: 'Disjoint response' } }
        ]
      };
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-penumbra-project': 'test-project',
        'x-request-id': 'req-disjoint'
      },
      payload: {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Fail me' }]
      }
    });

    expect(response.statusCode).toBe(200);

    // wait for microtasks
    await new Promise(r => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalled();
    const calls = mockFetch.mock.calls;
    
    // It should have tried the prompt (failed) and then response (succeeded)
    expect(calls.length).toBe(2);
    
    const responseCallUrl = calls[1][0] as string;
    const responseCallOptions = calls[1][1] as any;
    
    expect(responseCallUrl).toBe('http://mock-daemon/observations');
    const responseBody = JSON.parse(responseCallOptions.body);
    expect(responseBody.event_type).toBe('agent-response');
    expect(responseBody.payload_summary).toBe('Disjoint response');
    
    // We expect a warning to have been logged about the prompt failure
    expect(warningLogged).toBe(true);
  });
});
