import type { QuotaStatusResponse } from "../penumbra-client.js";
import type { RateLimitDelta, UsageReader, UsageReaderResult } from "./index.js";

const DAILY_MS = 24 * 60 * 60 * 1000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DEFAULT_MAX_PLAUSIBLE_PCT = 300;

interface GoogleOtlpSynthCursor {
  last_emitted_minute: Record<string, number>;
}

type GoogleOtlpSynthWarn = (meta: Record<string, unknown>, msg: string) => void;

export interface GoogleOtlpSynthOptions {
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
  warn?: GoogleOtlpSynthWarn;
}

export class GoogleOtlpSynth implements UsageReader {
  readonly id = "google-otlp-synth";
  private readonly client: GoogleOtlpSynthOptions["client"];
  private readonly now: () => Date;
  private readonly minEmitPct: number;
  private readonly maxPlausiblePct: number;
  private readonly warn: GoogleOtlpSynthWarn;
  private readonly warnedImplausibleModels = new Set<string>();

  constructor(opts: GoogleOtlpSynthOptions) {
    this.client = opts.client;
    this.now = opts.now ?? (() => new Date());
    this.minEmitPct = opts.min_emit_pct ?? 0;
    this.maxPlausiblePct = opts.max_plausible_pct ?? parseMaxPlausiblePct(opts.env ?? process.env);
    this.warn =
      opts.warn ??
      ((meta, msg) => {
        console.warn(msg, meta);
      });
  }

  async read(previousCursor: unknown | null): Promise<UsageReaderResult> {
    const cursor = normalizeCursor(previousCursor);
    const now = this.now();
    const nowMs = now.getTime();
    const minuteBucket = Math.floor(nowMs / MINUTE_MS);
    const nextCursor: GoogleOtlpSynthCursor = {
      last_emitted_minute: { ...cursor.last_emitted_minute },
    };

    const snapshots: RateLimitDelta[] = [];
    for (const window of [
      { label: "daily", ms: DAILY_MS, minutes: 1440, quotaWindow: "24h" as const },
      { label: "five_hour", ms: FIVE_HOUR_MS, minutes: 300, quotaWindow: "5h" as const },
    ] as const) {
      let status: QuotaStatusResponse;
      try {
        status = await this.client.fetchQuotaStatus({
          since: new Date(nowMs - window.ms).toISOString(),
          window: window.quotaWindow,
        });
      } catch {
        return {
          cursor,
          usage_deltas: [],
          rate_limit_snapshots: [],
        };
      }

      for (const row of status.providers) {
        if (row.provider !== "google") continue;
        if (!row.model) continue;
        if (row.quota_tokens == null || row.used_tokens == null) continue;

        const used = Number(row.used_tokens);
        const quota = Number(row.quota_tokens);
        if (!Number.isFinite(used) || !Number.isFinite(quota) || quota <= 0) continue;

        const dedupeKey = `${window.label} ${row.model}`;
        if (nextCursor.last_emitted_minute[dedupeKey] === minuteBucket) continue;
        const rawUsedPct = (used / quota) * 100;
        if (rawUsedPct > this.maxPlausiblePct) {
          this.warnImplausibleQuota(row.model, window.label, rawUsedPct, used, quota);
          continue;
        }
        const usedPct = clampPct(rawUsedPct);
        if (usedPct < this.minEmitPct) {
          // Cursor tracks emitted rows only; skipped rows can be re-evaluated next tick.
          continue;
        }

        snapshots.push({
          provider: "google",
          model: row.model,
          window_label: window.label,
          used_pct: usedPct,
          window_minutes: window.minutes,
        });
        nextCursor.last_emitted_minute[dedupeKey] = minuteBucket;
      }
    }

    return {
      cursor: nextCursor,
      usage_deltas: [],
      rate_limit_snapshots: snapshots,
    };
  }

  private warnImplausibleQuota(
    model: string,
    windowLabel: string,
    rawUsedPct: number,
    usedTokens: number,
    quotaTokens: number,
  ): void {
    if (this.warnedImplausibleModels.has(model)) return;
    this.warnedImplausibleModels.add(model);
    this.warn(
      {
        provider: "google",
        model,
        window_label: windowLabel,
        raw_used_pct: rawUsedPct,
        max_plausible_pct: this.maxPlausiblePct,
        used_tokens: usedTokens,
        quota_tokens: quotaTokens,
      },
      "google-otlp-synth: implausible quota ratio; skipping pressure snapshot",
    );
  }
}

function normalizeCursor(cursor: unknown | null): GoogleOtlpSynthCursor {
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
  const raw = env.PENUMBRA_GOOGLE_SYNTH_MAX_PLAUSIBLE_PCT;
  if (raw == null || raw.trim() === "") return DEFAULT_MAX_PLAUSIBLE_PCT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_PLAUSIBLE_PCT;
  return parsed;
}
