export interface UsageReaderDelta {
  provider: string;
  model: string | null;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read?: number;
  tokens_cache_write?: number;
  /** USD cost for this delta. Null when source doesn't expose cost. */
  cost_usd: number | null;
  /** Time range covered by this delta (ISO8601). */
  window_start: string;
  window_end: string;
  /** Optional handoff_id correlation. Most local-state readers leave this null. */
  handoff_id?: string | null;
}

export interface RateLimitDelta {
  provider: string;
  /** "primary" | "secondary" for codex; "five_hour" | "seven_day" for claude statusline; etc. */
  window_label: string;
  /** Optional model scope. When present, the snapshot is for this specific model within `provider`. */
  model?: string | null;
  used_pct: number;
  /** Window length in minutes. Optional — claude doesn't expose this directly. */
  window_minutes?: number;
  /** Unix seconds until the window resets. */
  resets_at?: number;
  /** Vendor-specific extra fields, captured for forensics. */
  extra?: Record<string, unknown>;
}

export interface UsageReaderResult {
  /** Opaque cursor that the poller persists; passed back on the next call. */
  cursor: unknown;
  /** Token + cost deltas, one per (provider, model) bucket. */
  usage_deltas: UsageReaderDelta[];
  /** Rate-limit window snapshots. Empty for readers that don't observe rate limits. */
  rate_limit_snapshots: RateLimitDelta[];
}

export interface UsageReader {
  /** Stable identifier (used as cursor key + source_kind suffix). */
  readonly id: string;
  /** Read backing state from `previousCursor` to "now"; return new cursor + deltas. */
  read(previousCursor: unknown | null): Promise<UsageReaderResult>;
}
