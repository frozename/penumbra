import { PenumbraClient } from '../penumbra-client.js';

export interface RunApproveOpts {
  storageRoot: string;
  handoffId: string;
  redirectTo?: string;
  reject?: boolean;
  reason?: string;
}

export async function runApprove(opts: RunApproveOpts): Promise<{ handoff_id: string; status: string }> {
  const client = new PenumbraClient({ storageRoot: opts.storageRoot });
  const id = await resolveHandoffId(client, opts.handoffId);
  return client.approve(id, {
    redirect_to: opts.redirectTo,
    reject: opts.reject,
    reason: opts.reason,
  });
}

async function resolveHandoffId(client: PenumbraClient, idOrPrefix: string): Promise<string> {
  if (idOrPrefix.length >= 36) return idOrPrefix;
  const { handoffs } = await client.listPending();
  const matches = handoffs.filter((h: any) => typeof h.handoff_id === 'string' && h.handoff_id.startsWith(idOrPrefix));
  if (matches.length === 0) throw new Error(`no pending handoff matching prefix '${idOrPrefix}'`);
  if (matches.length > 1) throw new Error(`ambiguous prefix '${idOrPrefix}' (matched ${matches.length} handoffs)`);
  return matches[0].handoff_id;
}
