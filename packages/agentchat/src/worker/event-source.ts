export interface EventSourceLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface EventSourceClient {
  listHandoffs(opts: { statuses: string[] }): Promise<{ handoffs: any[] }>;
  subscribeHandoffEvents(opts?: { signal?: AbortSignal }): AsyncIterable<any>;
}

export interface EventSourceOpts {
  client: EventSourceClient;
  statuses: string[];
  onEvent: (row: any) => void;
  pollIntervalMs: number;
  /** Initial SSE reconnect delay; doubles up to a 5s cap. Default 500ms. */
  sseBackoffStartMs?: number;
  /** Cap on SSE reconnect delay. Default 5000ms. */
  sseBackoffCapMs?: number;
  /** Optional logger for daemon-unreachable events; throttled to once per minute. */
  log?: EventSourceLogger;
  /** Internal: override the throttle window. Tests use a small value to avoid sleep. */
  unreachableLogThrottleMs?: number;
}

export function startEventSource(opts: EventSourceOpts): () => Promise<void> {
  const seen = new Set<string>();
  const startMs = opts.sseBackoffStartMs ?? 500;
  const capMs = opts.sseBackoffCapMs ?? 5000;
  const throttleMs = opts.unreachableLogThrottleMs ?? 60_000;

  let stopped = false;
  let abort = new AbortController();
  let sseAlive = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let lastUnreachableLogAt = 0;

  const logUnreachable = (source: 'poll' | 'sse', err: unknown) => {
    if (!opts.log) return;
    const now = Date.now();
    if (now - lastUnreachableLogAt < throttleMs) return;
    lastUnreachableLogAt = now;
    opts.log.warn({ source, err: String(err) }, 'daemon unreachable, retrying');
  };

  const fanOut = (row: any) => {
    if (!row?.handoff_id) return;
    if (seen.has(row.handoff_id)) return;
    seen.add(row.handoff_id);
    try { opts.onEvent(row); } catch { /* one bad handler must not kill the loop */ }
  };

  const poll = async () => {
    if (stopped) return;
    if (!sseAlive) {
      try {
        const { handoffs } = await opts.client.listHandoffs({ statuses: opts.statuses });
        for (const h of handoffs) fanOut(h);
      } catch (err) {
        logUnreachable('poll', err);
      }
    }
    if (!stopped) pollTimer = setTimeout(poll, opts.pollIntervalMs);
  };
  void poll();

  const sseLoop = async () => {
    let backoff = startMs;
    while (!stopped) {
      try {
        sseAlive = true;
        for await (const ev of opts.client.subscribeHandoffEvents({ signal: abort.signal })) {
          if (stopped) break;
          fanOut(ev);
        }
        sseAlive = false;
      } catch (err) {
        sseAlive = false;
        logUnreachable('sse', err);
      }
      if (stopped) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, capMs);
    }
  };
  void sseLoop();

  return async () => {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    abort.abort();
  };
}