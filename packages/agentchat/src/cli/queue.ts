import { PenumbraClient } from "../penumbra-client.js";
import type { HandoffRow } from "@penumbra/core";

export async function runQueue(opts: {
  storageRoot: string;
  conversationId?: string;
  fetch?: typeof fetch;
}): Promise<HandoffRow[]> {
  const client = new PenumbraClient({ storageRoot: opts.storageRoot, fetch: opts.fetch });
  const r = await client.listPending({ conversation_id: opts.conversationId });
  return r.handoffs as HandoffRow[];
}
