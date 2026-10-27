import type { DispatchEventInput } from "@penumbra/core";

import type { RuntimeThoughtsConfig } from "./thought-config.js";

export interface RecordThoughtInput {
  handoffId: string;
  adapter: string;
  agentName: string;
  text: string;
  tokenCount?: number;
  ts?: string;
}

export interface ThoughtCaptureDeps {
  config: RuntimeThoughtsConfig;
  enqueue: (event: DispatchEventInput) => void;
  workerId?: string | null;
  now?: () => Date;
  /** Max retained per-dispatch state entries before LRU eviction. Default 1024. */
  perDispatchCapacity?: number;
}

const REDACTION_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
];

function redactCredentials(text: string): string {
  let out = text;
  for (const pattern of REDACTION_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

interface PendingThought {
  adapter: string;
  agentName: string;
  text: string;
  ts: string;
  chunkCount: number;
  tokenCount: number | undefined;
}

/** #297: a coalesced row needs at least this many chars before a sentence end or newline flushes it. */
export const THOUGHT_FLUSH_MIN_CHARS = 80;
/**
 * #297: a coalesced row is written once it reaches this many chars (or maxTextBytes
 * when that is lower). DispatchEventLog replaces any event meta whose JSON is over
 * 4096 chars with a `_truncated` stub, so a longer row would lose its text.
 */
const THOUGHT_ROW_MAX_CHARS = 2048;
/** #297: a possible-credential tail longer than this is written anyway. */
const MAX_HELD_TAIL_CHARS = 512;
/** #297: the start of each REDACTION_PATTERNS credential. */
const CREDENTIAL_PREFIXES = [
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "Bearer",
  "https://discord.com/api/webhooks/",
];
/** #297: a credential that runs to the end of the buffer may still be streaming. */
const OPEN_CREDENTIAL_AT_END: RegExp[] = [
  /sk-[A-Za-z0-9_-]*$/,
  /gh[pousr]_[A-Za-z0-9_]*$/,
  /Bearer\s*[A-Za-z0-9._-]*$/,
  /https:\/\/discord\.com\/api\/webhooks\/[\w/-]*$/,
];

function partialPrefixLength(text: string): number {
  let longest = 0;
  for (const prefix of CREDENTIAL_PREFIXES) {
    for (let k = Math.min(prefix.length - 1, text.length); k > longest; k--) {
      if (prefix.startsWith(text.slice(text.length - k))) {
        longest = k;
        break;
      }
    }
  }
  return longest;
}

/**
 * #297: length of the trailing fragment that could be a credential still being
 * streamed. Holding it back keeps the whole key in one row, so redactCredentials
 * sees it.
 */
export function heldTailLength(text: string): number {
  let held = partialPrefixLength(text);
  for (const pattern of OPEN_CREDENTIAL_AT_END) {
    const match = pattern.exec(text);
    if (match !== null) held = Math.max(held, match[0].length);
  }
  return held > MAX_HELD_TAIL_CHARS ? 0 : held;
}

function isThoughtFlushBoundary(text: string): boolean {
  return text.length >= THOUGHT_FLUSH_MIN_CHARS && (/[.?!]$/.test(text) || text.includes("\n"));
}

function newPendingThought(input: RecordThoughtInput, ts: string): PendingThought {
  return {
    adapter: input.adapter,
    agentName: input.agentName,
    text: "",
    ts,
    chunkCount: 0,
    tokenCount: undefined,
  };
}

interface DispatchState {
  sequence: number;
  bytesUsed: number;
  streamCapHit: boolean;
  pending: PendingThought | null;
}

const DEFAULT_PER_DISPATCH_CAPACITY = 1024;

export class ThoughtCapture {
  private readonly perDispatch = new Map<string, DispatchState>();
  private readonly perDispatchCapacity: number;

  constructor(private readonly deps: ThoughtCaptureDeps) {
    this.perDispatchCapacity = Math.max(
      1,
      deps.perDispatchCapacity ?? DEFAULT_PER_DISPATCH_CAPACITY,
    );
  }

  isAdapterEnabled(adapter: string, agentName: string): boolean {
    if (!this.deps.config.enabled) return false;
    const override = this.deps.config.capture.perAgentOverrides[agentName];
    if (override === false) return false;
    if (override === true) return true;
    return this.deps.config.capture.adapters[adapter] === true;
  }

  recordThought(input: RecordThoughtInput): void {
    if (!this.isAdapterEnabled(input.adapter, input.agentName)) return;
    this.emitRow(this.getOrCreateState(input.handoffId), input, undefined);
  }

  /**
   * #297: buffer one streamed chunk. stdio-acp sends about one token per chunk,
   * so the buffer is written as one agent.thought row when it reaches a sentence
   * end or newline with at least THOUGHT_FLUSH_MIN_CHARS chars, when it would
   * pass rowCap(), or on flush().
   */
  appendThoughtChunk(input: RecordThoughtInput): void {
    if (!this.isAdapterEnabled(input.adapter, input.agentName)) return;
    const state = this.getOrCreateState(input.handoffId);
    if (state.streamCapHit) return;
    const ts = input.ts ?? this.nowIso();
    const cap = this.rowCap();
    if (state.pending !== null && state.pending.text.length + input.text.length > cap) {
      this.flushPending(input.handoffId, state, ts);
    }
    const pending = state.pending ?? newPendingThought(input, ts);
    pending.text += input.text;
    pending.chunkCount += 1;
    if (input.tokenCount !== undefined) {
      pending.tokenCount = (pending.tokenCount ?? 0) + input.tokenCount;
    }
    state.pending = pending;
    if (pending.text.length >= cap || isThoughtFlushBoundary(pending.text)) {
      this.flushPending(input.handoffId, state, ts);
    }
  }

  /** #297: write the buffered text of a dispatch as one row, holding nothing back. */
  flush(handoffId: string): void {
    const state = this.perDispatch.get(handoffId);
    if (state === undefined) return;
    this.flushPending(handoffId, state, null);
  }

  /**
   * #297: write the buffered text as one row. With holdBackTs set, a trailing
   * fragment that may be a credential still streaming stays buffered for the
   * next row, stamped holdBackTs; with null everything is written.
   */
  private flushPending(handoffId: string, state: DispatchState, holdBackTs: string | null): void {
    const pending = state.pending;
    if (pending === null) return;
    const cap = this.rowCap();
    const held =
      holdBackTs !== null && pending.text.length < cap ? heldTailLength(pending.text) : 0;
    const emitText = pending.text.slice(0, pending.text.length - held);
    if (emitText.length === 0) {
      if (holdBackTs === null) state.pending = null;
      return;
    }
    state.pending =
      holdBackTs !== null && held > 0
        ? {
            ...pending,
            text: pending.text.slice(pending.text.length - held),
            ts: holdBackTs,
            chunkCount: 0,
            tokenCount: undefined,
          }
        : null;
    this.emitRow(
      state,
      {
        handoffId,
        adapter: pending.adapter,
        agentName: pending.agentName,
        text: emitText,
        tokenCount: pending.tokenCount,
        ts: pending.ts,
      },
      pending.chunkCount,
    );
  }

  private emitRow(
    state: DispatchState,
    input: RecordThoughtInput,
    chunkCount: number | undefined,
  ): void {
    if (state.streamCapHit) return;
    const ts = input.ts ?? this.nowIso();
    const sequence = state.sequence;
    state.sequence = sequence + 1;

    const redacted = redactCredentials(input.text);
    const cap = this.deps.config.capture.maxTextBytes;
    const truncated = redacted.length > cap ? redacted.slice(0, cap) : redacted;
    const droppedFromRow = redacted.length - truncated.length;

    const remaining = this.deps.config.capture.maxStreamBytes - state.bytesUsed;
    if (truncated.length > remaining) {
      const totalDropped = redacted.length + 0;
      state.streamCapHit = true;
      this.touchState(input.handoffId, state);
      this.deps.enqueue({
        handoff_id: input.handoffId,
        worker_id: this.deps.workerId ?? null,
        source: "worker",
        kind: "agent.thought.overflow",
        ts,
        meta: { sequence_n: -1, bytes_dropped: totalDropped },
      });
      return;
    }

    state.bytesUsed += truncated.length;
    this.touchState(input.handoffId, state);

    const thoughtMeta: Record<string, unknown> = {
      sequence_n: sequence,
      adapter: input.adapter,
      agent_name: input.agentName,
      text: truncated,
    };
    if (input.tokenCount !== undefined) thoughtMeta.token_count = input.tokenCount;
    if (chunkCount !== undefined) thoughtMeta.chunk_count = chunkCount;

    this.deps.enqueue({
      handoff_id: input.handoffId,
      worker_id: this.deps.workerId ?? null,
      source: "worker",
      kind: "agent.thought",
      ts,
      meta: thoughtMeta,
    });

    if (droppedFromRow > 0) {
      this.deps.enqueue({
        handoff_id: input.handoffId,
        worker_id: this.deps.workerId ?? null,
        source: "worker",
        kind: "agent.thought.overflow",
        ts,
        meta: { sequence_n: sequence, bytes_dropped: droppedFromRow },
      });
    }
  }

  /** #297: the largest coalesced row, in chars. */
  private rowCap(): number {
    return Math.min(this.deps.config.capture.maxTextBytes, THOUGHT_ROW_MAX_CHARS);
  }

  private nowIso(): string {
    return (this.deps.now ?? ((): Date => new Date()))().toISOString();
  }

  resetDispatch(handoffId: string): void {
    this.perDispatch.delete(handoffId);
  }

  /** @internal Test-only: current per-dispatch state size. */
  _perDispatchSize(): number {
    return this.perDispatch.size;
  }

  /**
   * Get-or-create a dispatch's state and refresh its LRU position. When the
   * map exceeds its capacity, evicts the oldest-by-insertion entry. JS Map
   * iteration is insertion-ordered, so re-inserting on touch keeps hot ids
   * at the tail and ages stale ids out.
   */
  private getOrCreateState(handoffId: string): DispatchState {
    const existing = this.perDispatch.get(handoffId);
    if (existing) {
      this.perDispatch.delete(handoffId);
      this.perDispatch.set(handoffId, existing);
      return existing;
    }
    if (this.perDispatch.size >= this.perDispatchCapacity) {
      const oldest = this.perDispatch.keys().next().value;
      if (oldest !== undefined) this.perDispatch.delete(oldest);
    }
    const state: DispatchState = { sequence: 0, bytesUsed: 0, streamCapHit: false, pending: null };
    this.perDispatch.set(handoffId, state);
    return state;
  }

  private touchState(handoffId: string, state: DispatchState): void {
    if (this.perDispatch.has(handoffId)) this.perDispatch.delete(handoffId);
    this.perDispatch.set(handoffId, state);
  }
}
