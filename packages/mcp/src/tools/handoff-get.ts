import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';
import { DaemonHttpError } from '../daemon-client.js';

export const HandoffGetInputShape = {
  handoff_id: z.string().min(1).describe('The ID of the handoff to retrieve.'),
};

export const handoffGetHandler = (daemon: DaemonClient) => async (args: { handoff_id: string }) => {
  try {
    const { handoff } = await daemon.getHandoff(args.handoff_id);
    return {
      content: [{ type: 'text', text: JSON.stringify({ handoff }, null, 2) }],
    };
  } catch (err) {
    if (isNotFound(err)) {
      return {
        content: [{ type: 'text', text: JSON.stringify(notFoundBody(err, args.handoff_id), null, 2) }],
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
