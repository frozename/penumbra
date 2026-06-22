import type { DispatchEventInput } from "@penumbra/core";

export interface EmitHeartbeatOpts {
  client: { postHeartbeat: (worker_id: string, signal?: AbortSignal) => Promise<void> };
  workerId: string;
  signal?: AbortSignal;
  onEvent?: (event: DispatchEventInput) => void;
}

export async function emitHeartbeat(opts: EmitHeartbeatOpts): Promise<void> {
  let err: unknown = null;
  try {
    await opts.client.postHeartbeat(opts.workerId, opts.signal);
  } catch (caught) {
    err = caught;
  } finally {
    opts.onEvent?.({
      handoff_id: "",
      worker_id: opts.workerId,
      source: "worker",
      kind: "heartbeat.sent",
      ts: new Date().toISOString(),
    });
  }
  if (err !== null) {
    if (err instanceof Error) throw err;
    throw new Error(typeof err === "string" ? err : JSON.stringify(err));
  }
}
