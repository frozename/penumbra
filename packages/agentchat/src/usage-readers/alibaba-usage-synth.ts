import { DEFAULT_ALIBABA_SYNTH_MAX_PLAUSIBLE_PCT } from "@penumbra/config";
import type { QuotaStatusResponse } from "../penumbra-client.js";
import type { RateLimitDelta, UsageReader, UsageReaderResult } from "./index.js";

const PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const ALIBABA_ANCHOR_MS = Date.parse("2026-09-02T15:53:00Z");
const ALIBABA_WINDOW = { label: "seven_day", minutes: 10_080, quotaWindow: "7d" as const };

interface AlibabaUsageSynthCursor {
  last_emitted_minute: Record<string, number>;
}

type AlibabaUsageSynthWarn = (meta: Record<string, unknown>, msg: string) => void;

export interface AlibabaUsageSynthOptions {
  client: {
    fetchQuotaStatus(args?: {
      since?: string;
      window?: "24h" | "5h" | "7d";
    }): Promise<QuotaStatusResponse>;
  };
  now?: () => Date;
  min_emit_pct?: number;
  max_plausible_pct?: number;
  env?: Record<string, string | undefined>;
  warn?: AlibabaUsageSynthWarn;
}

export class AlibabaUsageSynth implements UsageReader {
  readonly id = "alibaba-usage-synth";
  readonly machineGlobal = true;
  private readonly client: AlibabaUsageSynthOptions["client"];
  private readonly now: () => Date;
  private readonly minEmitPct: number;
  private readonly maxPlausiblePct: number;
  private readonly warn: AlibabaUsageSynthWarn;
  private warnedImplausible = false;

  constructor(opts: AlibabaUsageSynthOptions) {
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
    const { windowStartMs, nextResetMs } = alibabaWindowFor(nowMs);
    const nextCursor: AlibabaUsageSynthCursor = {
      last_emitted_minute: { ...cursor.last_emitted_minute },
    };

    const status = await this.fetchWeeklyStatus(windowStartMs);
    if (!status) {
      return {
        cursor,
        usage_deltas: [],
        rate_limit_snapshots: [],
      };
    }

    const snapshots: RateLimitDelta[] = [];
    for (const row of status.providers) {
      const snapshot = this.buildSnapshot(
        row,
        minuteBucket,
        nextCursor,
        windowStartMs,
        nextResetMs,
      );
      if (snapshot) snapshots.push(snapshot);
    }

    return {
      cursor: nextCursor,
      usage_deltas: [],
      rate_limit_snapshots: snapshots,
    };
  }

  private async fetchWeeklyStatus(windowStartMs: number): Promise<QuotaStatusResponse | null> {
    try {
      return await this.client.fetchQuotaStatus({
        since: new Date(windowStartMs).toISOString(),
        window: ALIBABA_WINDOW.quotaWindow,
      });
    } catch {
      return null;
    }
  }

  private buildSnapshot(
    row: QuotaStatusResponse["providers"][number],
    minuteBucket: number,
    nextCursor: AlibabaUsageSynthCursor,
    windowStartMs: number,
    nextResetMs: number,
  ): RateLimitDelta | null {
    if (row.provider !== "alibaba" || row.model) return null;
    const quota = row.quota_tokens;
    if (
      quota === null ||
      !Number.isFinite(row.used_tokens) ||
      !Number.isFinite(quota) ||
      quota <= 0
    )
      return null;
    const dedupeKey = ALIBABA_WINDOW.label;
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
      provider: "alibaba",
      window_label: ALIBABA_WINDOW.label,
      used_pct: usedPct,
      window_minutes: ALIBABA_WINDOW.minutes,
      resets_at: Math.floor(nextResetMs / 1000),
      extra: {
        window_start: new Date(windowStartMs).toISOString(),
        quota_tokens: quota,
        used_tokens: row.used_tokens,
      },
    };
  }

  private warnImplausibleQuota(rawUsedPct: number, usedTokens: number, quotaTokens: number): void {
    if (this.warnedImplausible) return;
    this.warnedImplausible = true;
    this.warn(
      {
        provider: "alibaba",
        window_label: ALIBABA_WINDOW.label,
        raw_used_pct: rawUsedPct,
        max_plausible_pct: this.maxPlausiblePct,
        used_tokens: usedTokens,
        quota_tokens: quotaTokens,
      },
      "alibaba-usage-synth: implausible quota ratio; skipping pressure snapshot",
    );
  }
}

function alibabaWindowFor(nowMs: number): { windowStartMs: number; nextResetMs: number } {
  const periodsSinceAnchor = Math.floor((nowMs - ALIBABA_ANCHOR_MS) / PERIOD_MS);
  const windowStartMs = ALIBABA_ANCHOR_MS + periodsSinceAnchor * PERIOD_MS;
  return { windowStartMs, nextResetMs: windowStartMs + PERIOD_MS };
}

function normalizeCursor(cursor: unknown): AlibabaUsageSynthCursor {
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
  const raw = env.PENUMBRA_ALIBABA_SYNTH_MAX_PLAUSIBLE_PCT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_ALIBABA_SYNTH_MAX_PLAUSIBLE_PCT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ALIBABA_SYNTH_MAX_PLAUSIBLE_PCT;
  return parsed;
}
