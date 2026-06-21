import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";

import type { DaemonClient } from "../daemon-client.js";

export const WorkflowListInputShape = {} as const;

export function workflowListHandler(daemon: DaemonClient): () => Promise<TextContentEnvelope> {
  return async (): Promise<TextContentEnvelope> => toTextContent(await daemon.workflowList());
}
