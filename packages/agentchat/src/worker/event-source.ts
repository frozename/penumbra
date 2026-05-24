export interface EventSourceLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface EventSourceClient {
  listHandoffs(opts: { statuses: string[]; conversation_id?: string; project_id?: string | null }): Promise<{ handoffs: any[] }>;
  subscribeHandoffEvents(opts?: { signal?: AbortSignal }): AsyncIterable<any>;
}

type IsolationMode = 'shared' | 'sticky' | 'hard';

export interface EventSourceOpts {
  client: EventSourceClient;
  statuses: string[];
  onEvent: (row: any) => void;
  pollIntervalMs: number;
  project_id?: string;
  isolation?: IsolationMode;
  /** Initial SSE reconnect delay; doubles up to a 5s cap. Default 500ms. */
  sseBackoffStartMs?: number;
  /** Cap on SSE reconnect delay. Default 5000ms. */
  sseBackoffCapMs?: number;
  /** Optional logger for daemon-unreachable events; throttled to once per minute. */
  log?: EventSourceLogger;
  /** Internal: override the throttle window. Tests use a small value to avoid sleep. */
  unreachableLogThrottleMs?: number;
}

export interface EventSourceHandle {
  stop(): Promise<void>;
  /** Drop a handoff_id from the dedup set so a future SSE/poll event for the same id triggers the handler again. Use this when the handler had a transient failure and wants the row re-tried on next surfacing. */
  forget(handoff_id: string): void;
}

export function startEventSource(opts: EventSourceOpts): EventSourceHandle {
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
        const isolation = opts.isolation;
        const project_id = opts.project_id;
        let handoffs: any[] = [];
        if (isolation === 'hard' && project_id) {
          ({ handoffs } = await opts.client.listHandoffs({
            statuses: opts.statuses,
            project_id,
          }));
        } else if (isolation === 'sticky' && project_id) {
          ({ handoffs } = await opts.client.listHandoffs({
            statuses: opts.statuses,
            project_id,
          }));
          if (handoffs.length === 0) {
            ({ handoffs } = await opts.client.listHandoffs({ statuses: opts.statuses }));
          }
        } else {
          ({ handoffs } = await opts.client.listHandoffs({ statuses: opts.statuses }));
        }
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

  return {
    async stop() {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      abort.abort();
    },
    forget(handoff_id: string) {
      seen.delete(handoff_id);
    },
  };
}
