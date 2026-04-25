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
  return client.approve(opts.handoffId, {
    redirect_to: opts.redirectTo,
    reject: opts.reject,
    reason: opts.reason,
  });
}
