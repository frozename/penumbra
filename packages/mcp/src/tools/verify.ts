import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const VerifyInputShape = {
  memory_id: z.string().min(1),
  by: z.string().optional(),
  reason: z.string().optional(),
  session_id: z.string().optional(),
};

const VerifySchema = z.object(VerifyInputShape);

export function verifyHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = VerifySchema.parse(input);
    return toTextContent(await daemon.memoryVerify(parsed));
  };
}
