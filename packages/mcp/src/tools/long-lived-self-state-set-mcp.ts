import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";

import type { DaemonClient } from "../daemon-client.js";

import { getLongLivedRuntimeContext } from "../long-lived-context.js";
import { withDaemonDb } from "../runtime-db.js";
import {
  handleLongLivedSelfStateSet,
  SelfStateSetArgsSchema,
  SelfStateSetInputShape,
} from "./long-lived-self-state-set.js";

export { SelfStateSetInputShape as LongLivedSelfStateSetInputShape };

export function longLivedSelfStateSetHandler(_daemon: DaemonClient) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = SelfStateSetArgsSchema.parse(input ?? {});
    const ctx = getLongLivedRuntimeContext();
    const out = await withDaemonDb((db) => handleLongLivedSelfStateSet(db, ctx, parsed));
    return toTextContent(out);
  };
}
