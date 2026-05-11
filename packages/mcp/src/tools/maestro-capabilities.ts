import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const MaestroCapabilitiesInputShape = {} as const;

export function maestroCapabilitiesHandler(daemon: Pick<DaemonClient, 'maestroCapabilities'>) {
  return async () => toTextContent(await daemon.maestroCapabilities());
}
