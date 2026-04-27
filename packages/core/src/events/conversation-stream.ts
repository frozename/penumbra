import type { ConversationStreamEvent, HopStateCacheEntry } from '../schemas/sse-events.js';

export type ConversationStreamListener = (conversation_id: string, event: ConversationStreamEvent) => void;

/**
 * Manages live emission and transient in-memory caching of conversation progress events.
 * The cache is used to "fast-forward" new SSE subscribers to the current state of the active hop.
 */
export class ConversationStreamBus {
  private listeners = new Set<ConversationStreamListener>();
  private cache = new Map<string, HopStateCacheEntry>();

  subscribe(fn: ConversationStreamListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  emit(conversation_id: string, event: ConversationStreamEvent): void {
    // Transient cache management:
    // We cache hop-start and token events so new subscribers can catch up.
    // We clear the cache on hop-end or chain-end because the "current context" is over.
    if (event.type === 'hop-start') {
      this.cache.set(conversation_id, {
        conversation_id,
        hop_start: event,
        tokens: [],
      });
    } else if (event.type === 'token') {
      const entry = this.cache.get(conversation_id);
      if (entry && entry.hop_start.handoff_id === event.handoff_id) {
        entry.tokens.push(event);
      }
    } else if (event.type === 'hop-end' || event.type === 'chain-end') {
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
}
