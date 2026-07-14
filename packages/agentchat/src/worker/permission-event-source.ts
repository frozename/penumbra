export type PermissionEventSourceListener = (evt: { data: string; lastEventId?: string }) => void;

export interface PermissionEventSource {
  addEventListener: (name: string, fn: PermissionEventSourceListener) => void;
  onReconnect: (fn: () => void) => () => void;
  close: () => void;
  /** @internal Test-only: resolves when the pump loop has exited (after close()). */
  _done: () => Promise<void>;
}

/**
 * Daemon SSE credentials read fresh on every (re)connect so a daemon
 * token-rotation (rewrite of `${storageRoot}/token`) is picked up without
 * restarting the worker. Mirrors PenumbraClient.subscribeSse's resolve()-per
 * -connect pattern so the permission stream survives the same daemon restart
 * that the control + conversation streams already do.
 */
export interface PermissionSseCreds {
  baseUrl: string;
  token: string;
}

export interface CreatePermissionEventSourceOpts {
  fetchImpl?: typeof fetch;
  /** Initial reconnect delay (ms). Default 200ms. */
  backoffStartMs?: number;
  /** Cap on reconnect delay (ms). Default 30_000ms. */
  backoffCapMs?: number;
}

interface ParsedSseFrame {
  eventName: string;
  lastEventId: string | undefined;
  data: string;
}

function parseSseFrame(frame: string): ParsedSseFrame | null {
  let eventName = "";
  let lastEventId: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    } else if (line.startsWith("id:")) {
      lastEventId = line.slice(3).trim();
    }
  }
  if (!eventName || dataLines.length === 0) {
    return null;
  }
  return { eventName, lastEventId, data: dataLines.join("\n") };
}

/**
 * SSE consumer for `/permissions/events`. Native EventSource (browser API +
 * bun's global) doesn't support custom headers, so the daemon's bearer auth
 * would never be sent — this is the authoritative path until a polyfill with
 * authenticated reconnect lands.
 *
 * `resolveCreds` is called at the START of every (re)connect, so a rotated
 * daemon token (e.g. after `launchctl kickstart` writes a new
 * `${storageRoot}/token`) is picked up on the next reconnect rather than
 * stranding the pump on the stale boot-captured token. On any transport /
 * HTTP error (including 401/403 from a rotated token that hadn't been
 * re-read yet) the pump backs off and retries — it never permanently gives
 * up until `close()`.
 */
export function createPermissionEventSource(
  pathSuffix: string,
  resolveCreds: () => PermissionSseCreds,
  opts: CreatePermissionEventSourceOpts = {},
): PermissionEventSource {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const backoffStartMs = opts.backoffStartMs ?? 200;
  const backoffCapMs = opts.backoffCapMs ?? 30_000;

  const listeners = new Map<string, Set<PermissionEventSourceListener>>();
  const reconnectListeners = new Set<() => void>();
  const controller = new AbortController();
  let closed = false;
  let backoffMs = backoffStartMs;

  const fireReconnectListeners = (): void => {
    for (const fn of reconnectListeners) {
      fn();
    }
  };

  const emit = (name: string, data: string, lastEventId?: string): void => {
    for (const fn of listeners.get(name) ?? []) {
      fn({ data, lastEventId });
    }
  };

  const handleFrame = (frame: string): void => {
    const parsed = parseSseFrame(frame);
    if (parsed) {
      emit(parsed.eventName, parsed.data, parsed.lastEventId);
    }
  };

  const isStopped = (): boolean => closed || controller.signal.aborted;

  const consumeBody = async (body: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    fireReconnectListeners();
    try {
      while (!isStopped()) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        backoffMs = backoffStartMs;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          handleFrame(frame);
        }
      }
    } finally {
      reader.releaseLock();
      try {
        await body.cancel();
      } catch {
        /* noop */
      }
    }
  };

  const cancellableSleep = async (ms: number): Promise<void> => {
    if (controller.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        controller.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  const pump = async (): Promise<void> => {
    while (!isStopped()) {
      try {
        // Re-read creds at the START of every (re)connect so a rotated
        // token is picked up. resolveCreds() throwing (e.g. missing token
        // file during a daemon restart) is treated as a transient error
        // and retried with backoff, matching the control listener's
        // continue-on-transient behavior.
        const { baseUrl, token } = resolveCreds();
        const res = await fetchImpl(`${baseUrl}${pathSuffix}`, {
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${token}`,
          },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`permissions SSE HTTP ${String(res.status)}`);
        }
        await consumeBody(res.body);
      } catch (err) {
        if (isStopped()) {
          return;
        }
        // Surface the failure so an operator can see a persistently-broken
        // permission stream instead of a silent forever-retry loop.
        console.error("permissions SSE stream error, retrying after backoff", {
          err: err instanceof Error ? err.message : String(err),
          backoff_ms: backoffMs,
        });
        await cancellableSleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, backoffCapMs);
      }
    }
  };
  const pumpPromise = pump();
  void pumpPromise;

  return {
    addEventListener(name: string, fn: PermissionEventSourceListener): void {
      let bucket = listeners.get(name);
      if (!bucket) {
        bucket = new Set();
        listeners.set(name, bucket);
      }
      bucket.add(fn);
    },
    onReconnect(fn: () => void): () => void {
      reconnectListeners.add(fn);
      return (): void => {
        reconnectListeners.delete(fn);
      };
    },
    close(): void {
      closed = true;
      controller.abort();
      reconnectListeners.clear();
      listeners.clear();
    },
    _done(): Promise<void> {
      return pumpPromise;
    },
  };
}
