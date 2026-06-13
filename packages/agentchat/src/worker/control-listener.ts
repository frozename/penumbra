import { PenumbraHttpError } from "../penumbra-client.js";
import type { DispatchEventInput } from "@penumbra/core";

export interface ControlListenerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface WorkerControlEvent {
  type: string;
  conversation_id?: string;
  handoff_id?: string;
  probe_id?: string;
  worker_id?: string;
}

export interface ControlListenerClient {
  subscribeWorkerControl(opts?: { signal?: AbortSignal }): AsyncIterable<WorkerControlEvent>;
  sendProbeAck(worker_id: string, probe_id: string): Promise<void>;
}

export interface ControlListenerDispatcher {
  cancel(conversation_id: string, handoff_id: string): void;
}

export interface ControlListenerOpts {
  client: ControlListenerClient;
  dispatcher: ControlListenerDispatcher;
  signal: AbortSignal;
  log: ControlListenerLogger;
  /**
   * Internal: override the throttle window.
   * Tests use a small or clock-controlled value to avoid sleep.
   */
  streamErrorLogThrottleMs?: number;
  /** Internal: override the sleep implementation (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Internal: override the clock implementation (tests). */
  now?: () => number;
  onEvent?: (event: DispatchEventInput) => void;
  onConfigReload?: () => void;
  workerId?: string;
}

const CONTROL_LISTENER_RECONNECT_DELAY_MS = 5000;
const CONTROL_LISTENER_STREAM_ERR_THROTTLE_MS = 60_000;

export function handleControlEvent(
  event: WorkerControlEvent,
  opts: Pick<
    ControlListenerOpts,
    "dispatcher" | "onEvent" | "workerId" | "client" | "onConfigReload"
  > & {
    log?: ControlListenerLogger;
  },
): void {
  if (event.type === "agentchat_reload") {
    opts.log?.info({}, "received agentchat_reload control event");
    opts.onConfigReload?.();
    return;
  }
  if (event.type === "cancel") {
    if (!event.conversation_id || !event.handoff_id) {
      opts.log?.warn(
        {
          event: "control_event_malformed",
          type: "cancel",
          payload: event,
        },
        "malformed cancel control event",
      );
      return;
    }
    const conversation_id = event.conversation_id;
    const handoff_id = event.handoff_id;
    opts.onEvent?.({
      handoff_id,
      worker_id: opts.workerId,
      source: "worker",
      kind: "cancel.received",
      ts: new Date().toISOString(),
      meta: { source: "sse" },
    });
    opts.dispatcher.cancel(conversation_id, handoff_id);
    return;
  }
  if (event.type === "ping") {
    if (event.worker_id !== opts.workerId) return;
    if (!event.worker_id || !event.probe_id) return;
    void opts.client.sendProbeAck(event.worker_id, event.probe_id).catch((err) => {
      opts.log?.warn(
        {
          worker_id: event.worker_id,
          probe_id: event.probe_id,
          err: String(err),
        },
        "probe-ack failed",
      );
    });
  }
}

export async function runWorkerControlListener(opts: ControlListenerOpts): Promise<void> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const throttleMs = opts.streamErrorLogThrottleMs ?? CONTROL_LISTENER_STREAM_ERR_THROTTLE_MS;

  let lastLoggedAtMs = Number.NEGATIVE_INFINITY;
  let suppressedCount = 0;

  const logStreamError = (err: unknown) => {
    const ts = now();
    if (ts - lastLoggedAtMs < throttleMs) {
      suppressedCount++;
      return;
    }

    const obj: Record<string, unknown> = { err: String(err) };
    if (suppressedCount > 0) obj.suppressedCount = suppressedCount;
    suppressedCount = 0;
    lastLoggedAtMs = ts;
    opts.log.warn(obj, "control listener stream error; reconnecting in 5s");
  };

  while (!opts.signal.aborted) {
    try {
      for await (const event of opts.client.subscribeWorkerControl({ signal: opts.signal })) {
        if (opts.signal.aborted) return;
        handleControlEvent(event, opts);
      }
      if (opts.signal.aborted) return;
      await sleep(CONTROL_LISTENER_RECONNECT_DELAY_MS);
    } catch (err) {
      if (opts.signal.aborted) return;

      const status = err instanceof PenumbraHttpError ? err.status : null;
      if (status === 401 || status === 403 || status === 404) {
        opts.log.error(
          { status, err: String(err) },
          "control listener permanent failure; giving up",
        );
        return;
      }

      logStreamError(err);
      await sleep(CONTROL_LISTENER_RECONNECT_DELAY_MS);
    }
  }
}
