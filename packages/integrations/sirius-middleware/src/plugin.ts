import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { PenumbraDaemonClient } from './daemon-client.js'; 
import {
  buildPromptEvent,
  type ChatMessage,
} from './observation-builder.js';

export interface PenumbraPluginOptions {
  baseUrl?: string;
  token?: string;
  machineId?: string;
  logger?: any;
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
    (req as any).penumbraSession = { sessionId, projectId }; 
    
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
});
