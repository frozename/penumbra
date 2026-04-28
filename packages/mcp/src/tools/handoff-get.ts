import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';
import { DaemonHttpError } from '../daemon-client.js';

export const HandoffGetInputShape = {
  handoff_id: z.string().min(1).describe('The ID of the handoff to retrieve.'),
  compact: z.boolean().optional().describe('When true, omits the original prompt and truncates resolution_reason to head 500 + tail 500 chars. Saves ~1500-2500 tokens per call. Default false.'),
};

function applyCompactTransform(handoff: any) {
  const out = { ...handoff };
  delete out.message;
  if (typeof out.resolution_reason === 'string' && out.resolution_reason.length > 1100) {
    const head = out.resolution_reason.slice(0, 500);
    const tail = out.resolution_reason.slice(-500);
    const truncated = out.resolution_reason.length - 1000;
    out.resolution_reason = `${head}\n[... truncated ${truncated} chars ...]\n${tail}`;
  }
  return out;
}

import { formatHandoffGet, wrapWithSummary } from '../format-summary.js';

export const handoffGetHandler = (daemon: DaemonClient) => async (args: { handoff_id: string; compact?: boolean }) => {
  try {
    const { handoff } = await daemon.getHandoff(args.handoff_id);
    const output = args.compact ? applyCompactTransform(handoff) : handoff;
    const payload = { handoff: output };
    return {
      content: [{
        type: 'text',
        text: wrapWithSummary(formatHandoffGet(payload), payload),
      }],
    };
  } catch (err) {
    if (isNotFound(err)) {
      const payload = notFoundBody(err, args.handoff_id);
      return {
        content: [{
          type: 'text',
          text: wrapWithSummary(`◑ handoff  not found`, payload),
        }],
      };
    }
    throw err;
  }
};

function isNotFound(err: unknown): err is DaemonHttpError {
  return err instanceof DaemonHttpError && err.status === 404;
}

function notFoundBody(err: DaemonHttpError | { body?: unknown }, handoff_id: string) {
  const body = 'body' in err ? err.body : undefined;
  if (
    typeof body === 'object' &&
    body !== null &&
    'error' in body
  ) {
    return body;
  }
  return { error: { code: 'not_found', message: `handoff ${handoff_id} not found` } };
}
