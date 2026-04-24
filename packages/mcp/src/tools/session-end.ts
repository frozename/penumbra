import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const SessionEndInputShape = {
  session_id: z.string().min(1),
};

const SessionEndSchema = z.object(SessionEndInputShape);

export function sessionEndHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = SessionEndSchema.parse(input);
    const r = await daemon.endSession(parsed.session_id);
    return toTextContent(r);
  };
}
