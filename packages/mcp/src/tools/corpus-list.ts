import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";

import type { DaemonClient } from "../daemon-client.js";

export const CorpusListInputShape = {} as const;

export function corpusListHandler(daemon: DaemonClient) {
  return async (): Promise<TextContentEnvelope> => toTextContent(await daemon.corpusList());
}
