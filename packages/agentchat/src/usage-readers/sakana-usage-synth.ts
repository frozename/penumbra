import type { QuotaStatusResponse } from "../penumbra-client.js";
import type { RateLimitDelta, UsageReader, UsageReaderResult } from "./index.js";

const DAILY_MS = 24 * 60 * 60 * 1000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DEFAULT_MAX_PLAUSIBLE_PCT = 300;
const SAKANA_WINDOW = { label: "rolling-5h", minutes: 300, quotaWindow: "5h" as const };

interface SakanaUsageSynthCursor {
  last_emitted_minute: Record<string, number>;
}

type SakanaUsageSynthWarn = (meta: Record<string, unknown>, msg: string) => void;

export interface SakanaUsageSynthOptions {
  client: {
    fetchQuotaStatus(args?: {
      since?: string;
      window?: "24h" | "5h";
    }): Promise<QuotaStatusResponse>;
  };
  now?: () => Date;
  min_emit_pct?: number;
  max_plausible_pct?: number;
  env?: Record<string, string | undefined>;
  warn?: SakanaUsageSynthWarn;
}

export class SakanaUsageSynth implements UsageReader {
  readonly id = "sakana-usage-synth";
  readonly machineGlobal = true;
  private readonly client: SakanaUsageSynthOptions["client"];
  private readonly now: () => Date;
  private readonly minEmitPct: number;
  private readonly maxPlausiblePct: number;
  private readonly warn: SakanaUsageSynthWarn;
  private warnedImplausible = false;

  constructor(opts: SakanaUsageSynthOptions) {
    this.client = opts.client;
    this.now = opts.now ?? ((): Date => new Date());
    this.minEmitPct = opts.min_emit_pct ?? 0;
    this.maxPlausiblePct = opts.max_plausible_pct ?? parseMaxPlausiblePct(opts.env ?? process.env);
    this.warn =
      opts.warn ??
      ((meta, msg): void => {
        console.warn(msg, meta);
      });
  }

  async read(previousCursor: unknown): Promise<UsageReaderResult> {
    const cursor = normalizeCursor(previousCursor);
    const now = this.now();
    const nowMs = now.getTime();
    const minuteBucket = Math.floor(nowMs / MINUTE_MS);
    const nextCursor: SakanaUsageSynthCursor = {
      last_emitted_minute: { ...cursor.last_emitted_minute },
    };

    const status = await this.fetchDailyStatus(nowMs);
    if (!status) {
      return {
        cursor,
        usage_deltas: [],
        rate_limit_snapshots: [],
      };
    }

    const snapshots: RateLimitDelta[] = [];
    for (const row of status.providers) {
      const snapshot = this.buildSnapshot(row, minuteBucket, nextCursor);
      if (snapshot) snapshots.push(snapshot);
    }

    return {
      cursor: nextCursor,
      usage_deltas: [],
      rate_limit_snapshots: snapshots,
    };
  }

  private async fetchDailyStatus(nowMs: number): Promise<QuotaStatusResponse | null> {
    try {
      return await this.client.fetchQuotaStatus({
        since: new Date(nowMs - FIVE_HOUR_MS).toISOString(),
        window: SAKANA_WINDOW.quotaWindow,
      });
    } catch {
      return null;
    }
  }

  private buildSnapshot(
    row: QuotaStatusResponse["providers"][number],
    minuteBucket: number,
    nextCursor: SakanaUsageSynthCursor,
  ): RateLimitDelta | null {
    if (row.provider !== "sakana" || row.model) return null;
    const quota = row.quota_tokens;
    if (
      quota === null ||
      !Number.isFinite(row.used_tokens) ||
      !Number.isFinite(quota) ||
      quota <= 0
    )
      return null;
    const dedupeKey = SAKANA_WINDOW.label;
    if (nextCursor.last_emitted_minute[dedupeKey] === minuteBucket) return null;
    const rawUsedPct = (row.used_tokens / quota) * 100;
    if (rawUsedPct > this.maxPlausiblePct) {
      this.warnImplausibleQuota(rawUsedPct, row.used_tokens, quota);
      return null;
    }
    const usedPct = clampPct(rawUsedPct);
    if (usedPct < this.minEmitPct) return null;
    nextCursor.last_emitted_minute[dedupeKey] = minuteBucket;
    return {
      provider: "sakana",
      window_label: SAKANA_WINDOW.label,
      used_pct: usedPct,
      window_minutes: SAKANA_WINDOW.minutes,
    };
  }

  private warnImplausibleQuota(rawUsedPct: number, usedTokens: number, quotaTokens: number): void {
    if (this.warnedImplausible) return;
    this.warnedImplausible = true;
    this.warn(
      {
        provider: "sakana",
        window_label: SAKANA_WINDOW.label,
        raw_used_pct: rawUsedPct,
        max_plausible_pct: this.maxPlausiblePct,
        used_tokens: usedTokens,
        quota_tokens: quotaTokens,
      },
      "sakana-usage-synth: implausible quota ratio; skipping pressure snapshot",
    );
  }
}

function normalizeCursor(cursor: unknown): SakanaUsageSynthCursor {
  if (!cursor || typeof cursor !== "object") {
    return { last_emitted_minute: {} };
  }

  const candidate = (cursor as { last_emitted_minute?: unknown }).last_emitted_minute;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { last_emitted_minute: {} };
  }

  const cleaned: Record<string, number> = {};
  for (const [k, v] of Object.entries(candidate)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      cleaned[k] = v;
    }
  }
  return { last_emitted_minute: cleaned };
}

function clampPct(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function parseMaxPlausiblePct(env: Record<string, string | undefined>): number {
  const raw = env.PENUMBRA_SAKANA_SYNTH_MAX_PLAUSIBLE_PCT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_PLAUSIBLE_PCT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_PLAUSIBLE_PCT;
  return parsed;
}
