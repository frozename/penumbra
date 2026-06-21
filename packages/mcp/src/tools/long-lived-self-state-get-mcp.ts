import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";

import type { DaemonClient } from "../daemon-client.js";

import { getLongLivedRuntimeContext } from "../long-lived-context.js";
import { withDaemonDb } from "../runtime-db.js";
import { handleLongLivedSelfStateGet } from "./long-lived-self-state-get.js";

export const LongLivedSelfStateGetInputShape = {} as const;

export function longLivedSelfStateGetHandler(_daemon: DaemonClient) {
  return async (): Promise<TextContentEnvelope> => {
    const ctx = getLongLivedRuntimeContext();
    const out = await withDaemonDb((db) => handleLongLivedSelfStateGet(db, ctx, {}));
    return toTextContent(out);
  };
}
