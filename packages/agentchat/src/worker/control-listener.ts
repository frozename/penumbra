import { PenumbraHttpError } from '../penumbra-client.js';

export interface ControlListenerLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface WorkerControlEvent {
  type: string;
  conversation_id: string;
  handoff_id: string;
}

export interface ControlListenerClient {
  subscribeWorkerControl(opts?: { signal?: AbortSignal }): AsyncIterable<WorkerControlEvent>;
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
}

const CONTROL_LISTENER_RECONNECT_DELAY_MS = 5000;
const CONTROL_LISTENER_STREAM_ERR_THROTTLE_MS = 60_000;

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
    opts.log.warn(obj, 'control listener stream error; reconnecting in 5s');
  };

  while (!opts.signal.aborted) {
    try {
      for await (const event of opts.client.subscribeWorkerControl({ signal: opts.signal })) {
        if (opts.signal.aborted) return;
        if (event.type === 'cancel') {
          opts.dispatcher.cancel(event.conversation_id, event.handoff_id);
        }
      }
      if (opts.signal.aborted) return;
      await sleep(CONTROL_LISTENER_RECONNECT_DELAY_MS);
    } catch (err) {
      if (opts.signal.aborted) return;

      const status = err instanceof PenumbraHttpError ? err.status : null;
      if (status === 401 || status === 403 || status === 404) {
        opts.log.error({ status, err: String(err) }, 'control listener permanent failure; giving up');
        return;
      }

      logStreamError(err);
      await sleep(CONTROL_LISTENER_RECONNECT_DELAY_MS);
    }
  }
}
