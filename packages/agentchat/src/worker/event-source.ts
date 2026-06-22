export interface EventSourceLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Minimum shape an event-source row needs to fan out: a `handoff_id` for the
 * dedup gate and an optional `project_id` for `hard` isolation filtering.
 * Anything richer (e.g. the full `HandoffRow`) is assignable to this shape.
 */
export interface EventSourceRow {
  handoff_id?: string;
  project_id?: string | null;
}

export interface EventSourceListResult {
  handoffs: EventSourceRow[];
}

export interface EventSourceClient {
  listHandoffs(opts: {
    statuses: string[];
    conversation_id?: string;
    project_id?: string | null;
  }): Promise<EventSourceListResult>;
  subscribeHandoffEvents(opts?: { signal?: AbortSignal }): AsyncIterable<EventSourceRow>;
}

type IsolationMode = "shared" | "sticky" | "hard";

export interface EventSourceOpts {
  client: EventSourceClient;
  statuses: string[];
  onEvent: (row: EventSourceRow) => void;
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
  /** Max retained dedup entries before LRU eviction. Default 2048. */
  dedupCapacity?: number;
}

export interface EventSourceHandle {
  stop(): Promise<void>;
  /** Drop a handoff_id from the dedup set so a future SSE/poll event for the same id triggers the handler again. Use this when the handler had a transient failure and wants the row re-tried on next surfacing. */
  forget(handoff_id: string): void;
  /** @internal Test-only: current dedup set size. */
  _dedupSize(): number;
}

/**
 * Bounded LRU-by-insertion dedup set. Leans on JS Set's insertion-ordered
 * iteration: when capacity is exceeded, the oldest entry is evicted. A hit
 * refreshes recency by re-inserting at the tail, so ids that keep surfacing
 * stay hot while truly-stale ids age out.
 */
class BoundedSeen {
  private readonly set = new Set<string>();
  constructor(private readonly capacity: number) {}
  has(id: string): boolean {
    if (!this.set.has(id)) return false;
    this.set.delete(id);
    this.set.add(id);
    return true;
  }
  add(id: string): void {
    if (this.set.has(id)) {
      this.set.delete(id);
    } else if (this.set.size >= this.capacity) {
      const oldest = this.set.values().next().value;
      if (oldest !== undefined) this.set.delete(oldest);
    }
    this.set.add(id);
  }
  delete(id: string): boolean {
    return this.set.delete(id);
  }
  get size(): number {
    return this.set.size;
  }
}

async function fetchPollHandoffs(
  client: EventSourceClient,
  statuses: string[],
  isolation: IsolationMode | undefined,
  project_id: string | undefined,
): Promise<EventSourceRow[]> {
  if (isolation === "hard" && project_id !== undefined) {
    const res = await client.listHandoffs({ statuses, project_id });
    return res.handoffs;
  }
  if (isolation === "sticky" && project_id !== undefined) {
    const scoped = await client.listHandoffs({ statuses, project_id });
    if (scoped.handoffs.length > 0) return scoped.handoffs;
    const fallback = await client.listHandoffs({ statuses });
    return fallback.handoffs;
  }
  const res = await client.listHandoffs({ statuses });
  return res.handoffs;
}

function consumeSseEvent(
  ev: EventSourceRow,
  isolation: IsolationMode | undefined,
  project_id: string | undefined,
  fanOut: (row: EventSourceRow) => void,
): void {
  if (isolation === "hard" && project_id !== undefined && ev.project_id !== project_id) return;
  fanOut(ev);
}

export function startEventSource(opts: EventSourceOpts): EventSourceHandle {
  const capacity = Math.max(1, opts.dedupCapacity ?? 2048);
  const seen = new BoundedSeen(capacity);
  const startMs = opts.sseBackoffStartMs ?? 500;
  const capMs = opts.sseBackoffCapMs ?? 5000;
  const throttleMs = opts.unreachableLogThrottleMs ?? 60_000;

  // Mutable flags routed through getter/setter functions so control-flow
  // analysis can't narrow them into impossible-to-flip literals across the
  // poll/sseLoop/stop closures (no-unnecessary-condition).
  let stopped = false;
  let sseAlive = false;
  const isStopped = (): boolean => stopped;
  const isSseAlive = (): boolean => sseAlive;

  const abort = new AbortController();
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let lastUnreachableLogAt = 0;

  const logUnreachable = (source: "poll" | "sse", err: unknown): void => {
    if (!opts.log) return;
    const now = Date.now();
    if (now - lastUnreachableLogAt < throttleMs) return;
    lastUnreachableLogAt = now;
    opts.log.warn({ source, err: String(err) }, "daemon unreachable, retrying");
  };

  const fanOut = (row: EventSourceRow): void => {
    const id = row.handoff_id;
    if (!id) return;
    if (seen.has(id)) return;
    seen.add(id);
    try {
      opts.onEvent(row);
    } catch {
      /* one bad handler must not kill the loop */
    }
  };

  const poll = async (): Promise<void> => {
    if (isStopped()) return;
    if (!isSseAlive()) {
      try {
        const handoffs = await fetchPollHandoffs(
          opts.client,
          opts.statuses,
          opts.isolation,
          opts.project_id,
        );
        for (const h of handoffs) fanOut(h);
      } catch (err) {
        logUnreachable("poll", err);
      }
    }
    if (!isStopped()) {
      pollTimer = setTimeout(() => {
        void poll();
      }, opts.pollIntervalMs);
    }
  };
  void poll();

  const sseLoop = async (): Promise<void> => {
    let backoff = startMs;
    while (!isStopped()) {
      try {
        sseAlive = true;
        for await (const ev of opts.client.subscribeHandoffEvents({ signal: abort.signal })) {
          if (isStopped()) break;
          consumeSseEvent(ev, opts.isolation, opts.project_id, fanOut);
        }
        sseAlive = false;
      } catch (err) {
        sseAlive = false;
        logUnreachable("sse", err);
      }
      if (isStopped()) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, capMs);
    }
  };
  void sseLoop();

  return {
    stop(): Promise<void> {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      abort.abort();
      return Promise.resolve();
    },
    forget(handoff_id: string): void {
      seen.delete(handoff_id);
    },
    _dedupSize(): number {
      return seen.size;
    },
  };
}
