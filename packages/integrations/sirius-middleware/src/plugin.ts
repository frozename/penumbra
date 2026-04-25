import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { PenumbraDaemonClient } from './daemon-client.js'; 
import {
  buildPromptEvent,
  buildResponseEvent,
  type ChatMessage,
  type ChatResponseLike,
} from './observation-builder.js';

export interface PenumbraPluginOptions {
  baseUrl?: string;
  token?: string;
  machineId?: string;
  logger?: any;
}

function extractAssistantText(response: ChatResponseLike): string {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  if (first && first.message && typeof first.message.content === 'string') {
    return first.message.content;
  }
  return '';
}

export const penumbraObservePlugin: FastifyPluginAsync<PenumbraPluginOptions> = fp(async (fastify, options) => {
  const logger = options.logger || fastify.log;
  let dropped_observations = 0;

  if (!options.baseUrl) {
    logger.info({
      msg: 'penumbra middleware disabled',
      PENUMBRA_DAEMON_URL_present: false,
      PENUMBRA_DAEMON_TOKEN_present: !!options.token,
      reason: 'No baseUrl provided',
    });
    return;
  }

  const client = new PenumbraDaemonClient({ baseUrl: options.baseUrl, token: options.token });
  const machineId = options.machineId || 'unknown';

  fastify.addHook('preHandler', async (req, reply) => {
    const projectHeader = req.headers['x-penumbra-project'];
    if (!projectHeader || req.url !== '/v1/chat/completions') return;
    
    const projectId = Array.isArray(projectHeader) ? projectHeader[0] : projectHeader;
    if (!projectId) return;

    const sessionId = (req.headers['x-request-id'] as string) || randomUUID();
    const userId = (req.headers['x-penumbra-user'] as string) || 'anonymous';
    
    const captureStartTs = Date.now();
    const body = (req.body ?? {}) as { model?: string; messages?: ChatMessage[] };
    const messages = Array.isArray(body.messages) ? body.messages : [];

    const promptInput = {
      projectId,
      userId,
      machineId,
      requestId: sessionId,
      model: typeof body.model === 'string' ? body.model : 'unknown',
      messages,
      captureStartTs,
    };

    (req as any).penumbraSession = { sessionId, promptInput }; 

    const promptEvent = buildPromptEvent(promptInput);

    try {
        await client.observe(promptEvent);
    } catch (err: unknown) {
        dropped_observations++;
        logger.warn({
            msg: 'penumbra observe failed — dropping event',
            project_id: projectId,
            request_id: sessionId,
            route: req.url,
            error: err instanceof Error ? err.message : String(err)
        });
    }
  });

  fastify.addHook('onSend', (req, reply, payload, done) => {
    const session = (req as any).penumbraSession;
    if (!session || req.url !== '/v1/chat/completions') return done(null, payload);

    const { sessionId, promptInput } = session;

    if (typeof payload === 'string') {
      try {
        const body = JSON.parse(payload);
        const completionTs = Date.now();
        const responseEvent = buildResponseEvent({
          ...promptInput,
          assistantText: extractAssistantText(body),
          response: body,
          completionTs,
        });

        queueMicrotask(() => {
          client.observe(responseEvent).catch((err: unknown) => {
            dropped_observations++;
            logger.warn({
              msg: 'penumbra observe failed — dropping event',
              project_id: promptInput.projectId,
              request_id: sessionId,
              route: req.url,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        });
      } catch (err) {
         // handle parse error silently
      }
      return done(null, payload);
    }

    // Handle streaming (ReadableStream or NodeJS stream)
    if (payload && typeof (payload as any).on === 'function') {
      let accumulated = '';
      let buffered = '';
      const decoder = new TextDecoder();
      
      (payload as any).on('data', (chunk: any) => {
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataPayload = trimmed.slice('data:'.length).trim();
          if (!dataPayload || dataPayload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(dataPayload) as { choices?: { delta?: { content?: unknown } }[] };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') accumulated += delta;
          } catch { /* skip malformed chunk */ }
        }
      });

      (payload as any).on('end', () => {
        buffered += decoder.decode(); // flush with no args
        const lines = buffered.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataPayload = trimmed.slice('data:'.length).trim();
          if (!dataPayload || dataPayload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(dataPayload) as { choices?: { delta?: { content?: unknown } }[] };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') accumulated += delta;
          } catch { /* skip malformed chunk */ }
        }

        const completionTs = Date.now();
        const responseEvent = buildResponseEvent({
          ...promptInput,
          assistantText: accumulated,
          response: { choices: [], model: promptInput.model },
          completionTs,
        });

        queueMicrotask(() => {
          client.observe(responseEvent).catch((err: unknown) => {
            dropped_observations++;
            logger.warn({
              msg: 'penumbra observe failed — dropping event',
              project_id: promptInput.projectId,
              request_id: sessionId,
              route: req.url,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        });
      });

      return done(null, payload);
    }

    done(null, payload);
  });
});
