import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const LongLivedTickInputShape = {
  id: z.string().min(1),
};

export function longLivedTickHandler(daemon: DaemonClient) {
  return async (input: { id: string }) => toTextContent(await daemon.longLivedTick(input.id));
}
