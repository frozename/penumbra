import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { T0EventInput } from '@penumbra/core';
import { mergeMap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { PENUMBRA_CONFIG, PENUMBRA_DAEMON_CLIENT } from './tokens.js';
import type { MiddlewareConfig } from './config.js';
import type { PenumbraDaemonClient } from './daemon-client.js';
import {
  buildPromptEvent,
  buildResponseEvent,
  type ChatMessage,
  type ChatResponseLike,
} from './observation-builder.js';

const CHAT_PATH = '/v1/chat/completions';
const EMBED_PREFIX = '/v1/embeddings';

@Injectable()
export class PenumbraObserveInterceptor implements NestInterceptor {
  private readonly logger = new Logger('PenumbraObserveInterceptor');

  constructor(
    @Inject(PENUMBRA_CONFIG) private readonly config: MiddlewareConfig,
    @Inject(PENUMBRA_DAEMON_CLIENT) private readonly daemon: PenumbraDaemonClient,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.config.kind !== 'enabled') return next.handle();

    const httpCtx = context.switchToHttp();
    const req = httpCtx.getRequest<{
      method?: string;
      url?: string;
      originalUrl?: string;
      headers: Record<string, string | string[] | undefined>;
      body?: unknown;
    }>();

    const projectHeader = headerValue(req.headers, 'x-penumbra-project');
    if (!projectHeader) return next.handle();

    const path = normalizePath(req.url ?? req.originalUrl ?? '');
    if (path.startsWith(EMBED_PREFIX)) return next.handle();
    if (path !== CHAT_PATH || (req.method ?? '').toUpperCase() !== 'POST') return next.handle();

    const body = (req.body ?? {}) as { model?: string; messages?: ChatMessage[] };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const requestId = headerValue(req.headers, 'x-request-id') ?? crypto.randomUUID();
    const userId = headerValue(req.headers, 'x-penumbra-user') ?? 'anonymous';
    const captureStartTs = Date.now();

    const promptInput = {
      projectId: projectHeader,
      userId,
      machineId: this.config.machineId,
      requestId,
      model: typeof body.model === 'string' ? body.model : 'unknown',
      messages,
      captureStartTs,
    };

    return next.handle().pipe(
      mergeMap(async (responseValue) => {
        if (isReadableStream(responseValue)) {
          const { teedForResponse, accumulationDone } = teeAndAccumulate(responseValue);
          accumulationDone.then((accumulatedText) => {
            const completionTs = Date.now();
            const promptEvent = buildPromptEvent(promptInput);
            const responseEvent = buildResponseEvent({
              ...promptInput,
              assistantText: accumulatedText,
              response: { choices: [], model: promptInput.model },
              completionTs,
            });
            this.fireAndForget(promptEvent.session_id ?? requestId, promptEvent, 'agent-prompt');
            this.fireAndForget(responseEvent.session_id ?? requestId, responseEvent, 'agent-response');
          }).catch((err: unknown) => {
            this.logger.warn({
              msg: 'penumbra stream accumulation failed',
              error: err instanceof Error ? err.message : String(err),
            });
          });
          return teedForResponse;
        }

        const completionTs = Date.now();
        const response = (responseValue ?? {}) as ChatResponseLike;
        const assistantText = extractAssistantText(response);
        const promptEvent = buildPromptEvent(promptInput);
        const responseEvent = buildResponseEvent({
          ...promptInput,
          assistantText,
          response,
          completionTs,
        });
        this.fireAndForget(promptEvent.session_id ?? requestId, promptEvent, 'agent-prompt');
        this.fireAndForget(responseEvent.session_id ?? requestId, responseEvent, 'agent-response');
        return responseValue;
      }),
    );
  }

  private fireAndForget(sessionId: string, event: T0EventInput, label: string): void {
    queueMicrotask(() => {
      this.daemon.observe(event).catch((err: unknown) => {
        this.logger.warn({
          msg: 'penumbra observe failed — dropping event',
          label,
          session_id: sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : null;
  }
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') {
    const t = v[0].trim();
    return t.length > 0 ? t : null;
  }
  return null;
}

function normalizePath(url: string): string {
  try {
    return new URL(url, 'http://x').pathname.replace(/\/+$/, '') || '/';
  } catch {
    const q = url.indexOf('?');
    return (q === -1 ? url : url.slice(0, q)).replace(/\/+$/, '') || '/';
  }
}

function extractAssistantText(response: ChatResponseLike): string {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  if (first && first.message && typeof first.message.content === 'string') {
    return first.message.content;
  }
  return '';
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    value instanceof ReadableStream ||
    (typeof value === 'object' && value !== null && typeof (value as ReadableStream).getReader === 'function' &&
      typeof (value as ReadableStream).tee === 'function')
  );
}

function teeAndAccumulate(stream: ReadableStream<Uint8Array>): {
  teedForResponse: ReadableStream<Uint8Array>;
  accumulationDone: Promise<string>;
} {
  const [forResponse, forAccumulation] = stream.tee();
  const accumulationDone = (async () => {
    const reader = forAccumulation.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let assistantText = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice('data:'.length).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[] };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') assistantText += delta;
          } catch { /* skip malformed chunk */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
    return assistantText;
  })();
  return { teedForResponse: forResponse, accumulationDone };
}
