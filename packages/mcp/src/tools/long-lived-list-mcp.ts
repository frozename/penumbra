import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const LongLivedListInputShape = {} as const;

export function longLivedListHandler(daemon: DaemonClient) {
  return async () => toTextContent(await daemon.longLivedList());
}
