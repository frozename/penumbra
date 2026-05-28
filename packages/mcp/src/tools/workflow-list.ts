import { toTextContent } from "@nova/mcp-shared";
import type { DaemonClient } from "../daemon-client.js";

export const WorkflowListInputShape = {} as const;

export function workflowListHandler(daemon: DaemonClient) {
  return async () => toTextContent(await daemon.workflowList());
}
