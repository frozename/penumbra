import type {
  ConversationHopStartEvent,
  ConversationStreamEvent,
  ConversationTokenEvent,
} from "../schemas/sse-events.js";

export type ConversationStreamListener = (
  conversation_id: string,
  event: ConversationStreamEvent,
) => void;

export interface ConversationStreamBusOpts {
  /** Maximum number of distinct conversations to cache. Defaults to 64. */
  maxEntries?: number;
  /** Maximum tokens stored per cached hop. Defaults to 1024. */
  maxTokensPerEntry?: number;
  /** Cached entries older than this are reclaimed on the next emit. Defaults to 1 hour. */
  ttlMs?: number;
  /** Time source; injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_TOKENS_PER_ENTRY = 1024;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

interface CachedHopState {
  conversation_id: string;
  hop_start: ConversationHopStartEvent;
  tokens: ConversationTokenEvent[];
  last_ts: number;
}

/**
 * Manages live emission and transient in-memory caching of conversation progress events.
 * The cache is used to "fast-forward" new SSE subscribers to the current state of the active hop.
 *
 * The cache is bounded on three axes so a stuck or runaway conversation cannot grow it without
 * limit: (1) LRU eviction past maxEntries, (2) TTL reclaim of entries idle beyond ttlMs, and
 * (3) a sliding-window cap on token deltas per entry.
 */
export class ConversationStreamBus {
  private listeners = new Set<ConversationStreamListener>();
  private cache = new Map<string, CachedHopState>();
  private readonly maxEntries: number;
  private readonly maxTokensPerEntry: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: ConversationStreamBusOpts = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxTokensPerEntry = opts.maxTokensPerEntry ?? DEFAULT_MAX_TOKENS_PER_ENTRY;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  subscribe(fn: ConversationStreamListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(conversation_id: string, event: ConversationStreamEvent): void {
    const nowTs = this.now();
    this.evictStaleEntries(nowTs);

    if (event.type === "hop-start") {
      // Re-insert under the same key so its LRU position is the freshest.
      this.cache.delete(conversation_id);
      this.cache.set(conversation_id, {
        conversation_id,
        hop_start: event,
        tokens: [],
        last_ts: nowTs,
      });
      this.evictOverflowEntries();
    } else if (event.type === "token") {
      const entry = this.cache.get(conversation_id);
      if (entry?.hop_start.handoff_id === event.handoff_id) {
        entry.tokens.push(event);
        if (entry.tokens.length > this.maxTokensPerEntry) {
          // Sliding window: drop oldest tokens so a runaway hop cannot grow
          // a single entry without bound while late subscribers still see
          // the latest state.
          entry.tokens.splice(0, entry.tokens.length - this.maxTokensPerEntry);
        }
        entry.last_ts = nowTs;
        // Refresh LRU position so a live conversation never gets evicted by maxEntries.
        this.cache.delete(conversation_id);
        this.cache.set(conversation_id, entry);
      }
    } else if (event.type === "hop-end" || event.type === "chain-end") {
      this.cache.delete(conversation_id);
    }

    for (const fn of this.listeners) {
      try {
        fn(conversation_id, event);
      } catch {
        /* one bad subscriber must not block the others */
      }
    }
  }

  /**
   * Returns the cached events for a conversation (the current hop's start + deltas).
   */
  getHistory(conversation_id: string): ConversationStreamEvent[] {
    const entry = this.cache.get(conversation_id);
    if (!entry) return [];
    return [entry.hop_start, ...entry.tokens];
  }

  private evictStaleEntries(nowTs: number): void {
    const cutoff = nowTs - this.ttlMs;
    for (const [conversationId, entry] of this.cache) {
      if (entry.last_ts < cutoff) {
        this.cache.delete(conversationId);
      }
    }
  }

  private evictOverflowEntries(): void {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
