import { z } from 'zod';
import type { Services } from '@penumbra/core';
import { verifyRunningIdentity } from '../long-lived/identity.js';

import { json } from './_helpers.js';
const Input = z.object({
  agent_id: z.string().min(1),
  tick_id: z.string().min(1),
  tool: z.string().regex(/^[a-z0-9_-]+[.:][a-z0-9_.\-]+$/i, 'tool must be in <server>:<name> format'),
  args: z.unknown().optional(),
});

const MAX_BODY_BYTES = 1_048_576;
const QUEUED_MESSAGE = 'Action requires operator approval. Record an open_thread referencing pending_action_id.';

export async function longLivedMcpCallRoute(req: Request, services: Services): Promise<Response> {
  const contentLength = req.headers.get('content-length');
  if (contentLength != null && Number(contentLength) > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large' }, 413);
  }

  const parsed = Input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json({ error: 'invalid_input', details: parsed.error.flatten() }, 400);
  }

  const { agent_id, tick_id, tool, args } = parsed.data;
  if (!verifyRunningIdentity(services.db, agent_id, tick_id)) {
    return json({ error: 'identity_mismatch' }, 403);
  }

  if (!services.actionGate) {
    return json({ error: 'action_gate_not_configured' }, 503);
  }

  // Accept both `server.tool` (SEP-986 discovery form) and legacy `server:tool`;
  // canonicalize to colon-form for internal action-gate matching.
  const separator = tool.search(/[.:]/);
  const normalizedTool = separator >= 0 ? `${tool.slice(0, separator)}:${tool.slice(separator + 1)}` : tool;
  const result = await services.actionGate.handleCall({
    agent_id,
    tick_id,
    tool: normalizedTool,
    args: args ?? {},
  });

  if (result.kind === 'executed') {
    return json({ action_status: 'executed', result: result.result });
  }
  if (result.kind === 'queued') {
    return json({
      action_status: 'queued',
      pending_action_id: result.pending_action_id,
      message: QUEUED_MESSAGE,
    });
  }
  return json({
    action_status: 'rejected',
    error: result.error,
    ...(result.details === undefined ? {} : { details: result.details }),
  });
}
