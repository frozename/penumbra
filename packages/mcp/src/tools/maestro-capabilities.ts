import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";

import type { DaemonClient } from "../daemon-client.js";

export const MaestroCapabilitiesInputShape = {} as const;

export function maestroCapabilitiesHandler(daemon: Pick<DaemonClient, "maestroCapabilities">) {
  return async (): Promise<TextContentEnvelope> =>
    toTextContent(await daemon.maestroCapabilities());
}
