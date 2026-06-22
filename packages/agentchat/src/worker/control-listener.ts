import type { DispatchEventInput } from "@penumbra/core";

import { PenumbraHttpError } from "../penumbra-client.js";

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

// Function indirection prevents TS/eslint from narrowing the AbortSignal's
// boolean `aborted` getter to always-false across mid-loop checks.
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

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
    void opts.client.sendProbeAck(event.worker_id, event.probe_id).catch((err: unknown) => {
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

interface StreamErrorLoggerState {
  lastLoggedAtMs: number;
  suppressedCount: number;
}

function makeStreamErrorLogger(
  opts: ControlListenerOpts,
  throttleMs: number,
  now: () => number,
): (err: unknown) => void {
  const state: StreamErrorLoggerState = {
    lastLoggedAtMs: Number.NEGATIVE_INFINITY,
    suppressedCount: 0,
  };
  return (err: unknown): void => {
    const ts = now();
    if (ts - state.lastLoggedAtMs < throttleMs) {
      state.suppressedCount++;
      return;
    }
    const meta: Record<string, unknown> = { err: String(err) };
    if (state.suppressedCount > 0) meta.suppressedCount = state.suppressedCount;
    state.suppressedCount = 0;
    state.lastLoggedAtMs = ts;
    opts.log.warn(meta, "control listener stream error; reconnecting in 5s");
  };
}

function isPermanentStreamFailure(err: unknown): number | null {
  if (!(err instanceof PenumbraHttpError)) return null;
  if (err.status === 401 || err.status === 403 || err.status === 404) return err.status;
  return null;
}

type ControlLoopOutcome = "abort" | "permanent_failure" | "continue";

async function runControlListenerIteration(
  opts: ControlListenerOpts,
  sleep: (ms: number) => Promise<void>,
  logStreamError: (err: unknown) => void,
): Promise<ControlLoopOutcome> {
  try {
    for await (const event of opts.client.subscribeWorkerControl({ signal: opts.signal })) {
      if (isAborted(opts.signal)) return "abort";
      handleControlEvent(event, opts);
    }
    if (isAborted(opts.signal)) return "abort";
    await sleep(CONTROL_LISTENER_RECONNECT_DELAY_MS);
    return "continue";
  } catch (err) {
    if (isAborted(opts.signal)) return "abort";
    const permanentStatus = isPermanentStreamFailure(err);
    if (permanentStatus !== null) {
      opts.log.error(
        { status: permanentStatus, err: String(err) },
        "control listener permanent failure; giving up",
      );
      return "permanent_failure";
    }
    logStreamError(err);
    await sleep(CONTROL_LISTENER_RECONNECT_DELAY_MS);
    return "continue";
  }
}

export async function runWorkerControlListener(opts: ControlListenerOpts): Promise<void> {
  const sleep =
    opts.sleep ?? ((ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const throttleMs = opts.streamErrorLogThrottleMs ?? CONTROL_LISTENER_STREAM_ERR_THROTTLE_MS;
  const logStreamError = makeStreamErrorLogger(opts, throttleMs, now);

  while (!isAborted(opts.signal)) {
    const outcome = await runControlListenerIteration(opts, sleep, logStreamError);
    if (outcome !== "continue") return;
  }
}
