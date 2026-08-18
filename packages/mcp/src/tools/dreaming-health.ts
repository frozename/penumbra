import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const DreamingHealthInputShape = z.object({});

export type DreamingHealthInput = z.infer<typeof DreamingHealthInputShape>;

export function dreamingHealthHandler(daemon: DaemonClient): () => Promise<TextContentEnvelope> {
  return async (): Promise<TextContentEnvelope> => toTextContent(await daemon.dreamingHealth());
}
