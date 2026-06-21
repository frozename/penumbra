import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";

import type { DaemonClient } from "../daemon-client.js";

import { getLongLivedRuntimeContext } from "../long-lived-context.js";
import { withDaemonDb } from "../runtime-db.js";
import { handleLongLivedSelfPendingActions } from "./long-lived-self-pending-actions.js";

export const LongLivedSelfPendingActionsInputShape = {} as const;

export function longLivedSelfPendingActionsHandler(_daemon: DaemonClient) {
  return async (): Promise<TextContentEnvelope> => {
    const ctx = getLongLivedRuntimeContext();
    const out = await withDaemonDb((db) => handleLongLivedSelfPendingActions(db, ctx, {}));
    return toTextContent(out);
  };
}
