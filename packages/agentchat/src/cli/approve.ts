import { PenumbraClient } from "../penumbra-client.js";

export interface RunApproveOpts {
  storageRoot: string;
  handoffId: string;
  redirectTo?: string;
  reject?: boolean;
  reason?: string;
  resolvedBy?: string;
  fetch?: typeof fetch;
}

export async function runApprove(
  opts: RunApproveOpts,
): Promise<{ handoff_id: string; status: string }> {
  const client = new PenumbraClient({ storageRoot: opts.storageRoot, fetch: opts.fetch });
  const id = await resolveHandoffId(client, opts.handoffId);
  return await client.approve(id, {
    redirect_to: opts.redirectTo,
    reject: opts.reject,
    reason: opts.reason,
    resolved_by: opts.resolvedBy,
  });
}

async function resolveHandoffId(client: PenumbraClient, idOrPrefix: string): Promise<string> {
  if (idOrPrefix.length >= 36) return idOrPrefix;
  const { handoffs } = await client.listPending();
  const matches = handoffs.filter((h) => h.handoff_id.startsWith(idOrPrefix));
  if (matches.length === 0) throw new Error(`no pending handoff matching prefix '${idOrPrefix}'`);
  if (matches.length > 1)
    throw new Error(
      `ambiguous prefix '${idOrPrefix}' (matched ${String(matches.length)} handoffs)`,
    );
  const match = matches[0];
  if (!match) throw new Error(`no pending handoff matching prefix '${idOrPrefix}'`);
  return match.handoff_id;
}
