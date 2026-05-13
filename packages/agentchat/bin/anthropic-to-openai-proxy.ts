#!/usr/bin/env bun
import { translateAnthropicToOpenAI, translateOpenAIToAnthropic } from '../src/anthropic-proxy/translate.js';

const PORT = Number(process.env.ANTHROPIC_PROXY_PORT ?? '8190');
const UPSTREAM_URL = (process.env.OPENAI_UPSTREAM_URL ?? 'http://127.0.0.1:8181/v1').replace(/\/$/, '');
const UPSTREAM_MODEL = process.env.UPSTREAM_MODEL ?? 'gemma4-26b-a4b-mtp';
const UPSTREAM_API_KEY = process.env.OPENAI_UPSTREAM_API_KEY ?? 'local-no-auth';

function log(req: Request, model: string, hasTools: boolean, stream: boolean, upstreamStatus: number) {
  const method = req.method;
  const url = new URL(req.url);
  console.log(`${method} ${url.pathname} model=${model} has_tools=${hasTools} stream=${stream} upstream_status=${upstreamStatus}`);
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function parseUpstreamSse(res: Response) {
  if (!res.body) throw new Error('upstream stream has no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';
  const toolCalls: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }> = [];
  let finishReason: string | undefined;
  let lastUsage: { prompt_tokens?: number; completion_tokens?: number } = {};
  let lastModel: string | undefined;
  let lastId: string | undefined;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]' || payload === '') continue;
          let parsed: any;
          try { parsed = JSON.parse(payload); } catch { continue; }

          if (parsed.id) lastId = parsed.id;
          if (parsed.model) lastModel = parsed.model;

          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            fullContent += delta.content;
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls[idx]) {
                toolCalls[idx] = {
                  id: tc.id ?? '',
                  type: tc.type ?? 'function',
                  function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
                };
              } else {
                if (tc.function?.arguments) {
                  toolCalls[idx].function.arguments += tc.function.arguments;
                }
                if (tc.id) toolCalls[idx].id = tc.id;
                if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
              }
            }
          }

          const finish = parsed.choices?.[0]?.finish_reason;
          if (finish !== undefined && finish !== null) {
            finishReason = finish;
          }

          if (parsed.usage?.prompt_tokens !== undefined) {
            lastUsage.prompt_tokens = parsed.usage.prompt_tokens;
          }
          if (parsed.usage?.completion_tokens !== undefined) {
            lastUsage.completion_tokens = parsed.usage.completion_tokens;
          }
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  return {
    id: lastId ?? 'proxy-generated',
    choices: [
      {
        message: {
          role: 'assistant',
          content: fullContent || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: finishReason ?? 'stop',
      },
    ],
    usage: {
      prompt_tokens: lastUsage.prompt_tokens ?? 0,
      completion_tokens: lastUsage.completion_tokens ?? 0,
    },
  };
}

function streamAnthropicResponse(
  openaiRes: ReturnType<typeof translateOpenAIToAnthropic> extends Promise<infer T> ? T : never,
  upstreamId: string,
) {
  const encoder = new TextEncoder();
  let index = 0;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: upstreamId,
          type: 'message',
          role: 'assistant',
          model: openaiRes.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: openaiRes.usage.input_tokens, output_tokens: 0 },
        },
      })));

      for (const block of openaiRes.content) {
        if (block.type === 'text') {
          controller.enqueue(encoder.encode(sseEvent('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'text' },
          })));
          controller.enqueue(encoder.encode(sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: block.text },
          })));
          controller.enqueue(encoder.encode(sseEvent('content_block_stop', {
            type: 'content_block_stop',
            index,
          })));
          index++;
        } else if (block.type === 'tool_use') {
          controller.enqueue(encoder.encode(sseEvent('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: {},
            },
          })));
          const jsonStr = JSON.stringify(block.input);
          controller.enqueue(encoder.encode(sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: jsonStr },
          })));
          controller.enqueue(encoder.encode(sseEvent('content_block_stop', {
            type: 'content_block_stop',
            index,
          })));
          index++;
        }
      }

      controller.enqueue(encoder.encode(sseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: openaiRes.stop_reason, stop_sequence: null },
        usage: { input_tokens: openaiRes.usage.input_tokens, output_tokens: openaiRes.usage.output_tokens },
      })));

      controller.enqueue(encoder.encode(sseEvent('message_stop', {
        type: 'message_stop',
      })));

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    },
  });
}

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400 });
    }

    const upstreamBody = translateAnthropicToOpenAI(body, { upstreamModel: UPSTREAM_MODEL });
    const isStream = upstreamBody.stream === true;

    const upstreamReq: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${UPSTREAM_API_KEY}`,
      },
      body: JSON.stringify(upstreamBody),
    };

    const upstreamRes = await fetch(`${UPSTREAM_URL}/chat/completions`, upstreamReq);

    log(req, body.model ?? 'unknown', !!upstreamBody.tools, isStream, upstreamRes.status);

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text();
      return new Response(text, { status: upstreamRes.status });
    }

    if (isStream) {
      const openaiRes = await parseUpstreamSse(upstreamRes);
      const anthropicRes = translateOpenAIToAnthropic(openaiRes, { model: body.model ?? 'unknown' });
      return streamAnthropicResponse(anthropicRes, openaiRes.id);
    }

    const openaiRes = await upstreamRes.json();
    const anthropicRes = translateOpenAIToAnthropic(openaiRes, { model: body.model ?? 'unknown' });
    return new Response(JSON.stringify(anthropicRes), {
      headers: { 'content-type': 'application/json' },
    });
  },
});

console.log(`anthropic-to-openai-proxy listening on http://${server.hostname}:${server.port}`);
console.log(`upstream: ${UPSTREAM_URL} model=${UPSTREAM_MODEL}`);
