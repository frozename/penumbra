import { toTextContent } from "@nova/mcp-shared";
import type { DaemonClient } from "../daemon-client.js";

export const RecallStatusInputShape = {} as const;

export function recallStatusHandler(daemon: DaemonClient) {
  return async () => toTextContent(await daemon.recallStatus());
}
