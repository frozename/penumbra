import type { DispatchEventInput } from '@penumbra/core';

export interface EmitHeartbeatOpts {
  client: { postHeartbeat: (worker_id: string) => Promise<void> };
  workerId: string;
  onEvent?: (event: DispatchEventInput) => void;
}

export async function emitHeartbeat(opts: EmitHeartbeatOpts): Promise<void> {
  let err: unknown = null;
  try {
    await opts.client.postHeartbeat(opts.workerId);
  } catch (caught) {
    err = caught;
  } finally {
    opts.onEvent?.({
      handoff_id: '',
      worker_id: opts.workerId,
      source: 'worker',
      kind: 'heartbeat.sent',
      ts: new Date().toISOString(),
    });
  }
  if (err) throw err;
}
