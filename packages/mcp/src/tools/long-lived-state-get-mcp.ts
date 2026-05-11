import { z } from 'zod';
import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const LongLivedStateGetInputShape = {
  id: z.string().min(1),
};

export function longLivedStateGetHandler(daemon: DaemonClient) {
  return async (input: { id: string }) => toTextContent(await daemon.longLivedStateGet(input.id));
}
