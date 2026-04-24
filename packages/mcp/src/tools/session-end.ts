import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const SessionEndInputShape = {
  session_id: z.string().min(1),
};

export function sessionEndHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = z.object(SessionEndInputShape).parse(input);
    const r = await daemon.endSession(parsed.session_id);
    return toTextContent(r);
  };
}
