import type { QuotaStatusResponse } from "@src/penumbra-client.js";

import { SakanaUsageSynth } from "@src/usage-readers/sakana-usage-synth.js";
import { describe, expect, it } from "bun:test";

interface FetchQuotaArgs {
  since?: string;
  window?: "24h" | "5h";
}

function makeResponse(rows: QuotaStatusResponse["providers"]): QuotaStatusResponse {
  return {
    window: { from: "2026-06-22T12:00:00Z", to: "2026-06-23T12:00:00Z" },
    providers: rows,
  };
}

function sakanaQuotaRow(args: {
  used_tokens: number;
  quota_tokens: number | null;
}): QuotaStatusResponse["providers"][number] {
  return {
    provider: "sakana",
    used_usd: null,
    quota_usd: null,
    remaining_usd: null,
    remaining_pct_usd: null,
    used_tokens: args.used_tokens,
    quota_tokens: args.quota_tokens,
    remaining_tokens: args.quota_tokens === null ? null : args.quota_tokens - args.used_tokens,
    remaining_pct_tokens: null,
  };
}

describe("SakanaUsageSynth", () => {
  it("emits one provider-level rolling-5h snapshot from 5h quota status", async () => {
    const calls: FetchQuotaArgs[] = [];
    const reader = new SakanaUsageSynth({
      client: {
        fetchQuotaStatus(args?: FetchQuotaArgs): Promise<QuotaStatusResponse> {
          calls.push(args ?? {});
          return Promise.resolve(
            makeResponse([
              sakanaQuotaRow({ used_tokens: 250_000, quota_tokens: 1_000_000 }),
              {
                ...sakanaQuotaRow({ used_tokens: 900_000, quota_tokens: 1_000_000 }),
                model: "fugu-ultra-20260615",
              },
              {
                provider: "openai",
                used_usd: null,
                quota_usd: null,
                remaining_usd: null,
                remaining_pct_usd: null,
                used_tokens: 999,
                quota_tokens: 1000,
                remaining_tokens: 1,
                remaining_pct_tokens: 0.1,
              },
            ]),
          );
        },
      },
      now: (): Date => new Date("2026-06-23T12:34:30Z"),
    });

    const out = await reader.read(null);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.window).toBe("5h");
    expect(calls[0]?.since).toBe("2026-06-23T07:34:30.000Z");
    expect(out.usage_deltas).toHaveLength(0);
    expect(out.rate_limit_snapshots).toEqual([
      {
        provider: "sakana",
        window_label: "rolling-5h",
        used_pct: 25,
        window_minutes: 300,
      },
    ]);
  });

  it("emits no snapshot when quota_tokens_per_5h is absent", async () => {
    const reader = new SakanaUsageSynth({
      client: {
        fetchQuotaStatus(): Promise<QuotaStatusResponse> {
          return Promise.resolve(
            makeResponse([sakanaQuotaRow({ used_tokens: 12, quota_tokens: null })]),
          );
        },
      },
      now: (): Date => new Date("2026-06-23T12:34:30Z"),
    });

    const out = await reader.read(null);

    expect(out.rate_limit_snapshots).toHaveLength(0);
  });

  it("clamps plausible over-quota usage to 100%", async () => {
    const reader = new SakanaUsageSynth({
      client: {
        fetchQuotaStatus(): Promise<QuotaStatusResponse> {
          return Promise.resolve(
            makeResponse([sakanaQuotaRow({ used_tokens: 1_500_000, quota_tokens: 1_000_000 })]),
          );
        },
      },
      now: (): Date => new Date("2026-06-23T12:34:30Z"),
      max_plausible_pct: 200,
      warn: (): void => {
        throw new Error("unexpected warning");
      },
    });

    const out = await reader.read(null);

    expect(out.rate_limit_snapshots).toHaveLength(1);
    expect(out.rate_limit_snapshots[0]?.used_pct).toBe(100);
  });

  it("skips implausible ratios instead of emitting clamped snapshots", async () => {
    const warnings: { meta: Record<string, unknown>; msg: string }[] = [];
    const reader = new SakanaUsageSynth({
      client: {
        fetchQuotaStatus(): Promise<QuotaStatusResponse> {
          return Promise.resolve(
            makeResponse([sakanaQuotaRow({ used_tokens: 4_000_000, quota_tokens: 1_000_000 })]),
          );
        },
      },
      now: (): Date => new Date("2026-06-23T12:34:30Z"),
      max_plausible_pct: 300,
      warn: (meta, msg): number => warnings.push({ meta, msg }),
    });

    const out = await reader.read(null);

    expect(out.rate_limit_snapshots).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.meta).toMatchObject({
      provider: "sakana",
      window_label: "rolling-5h",
      raw_used_pct: 400,
    });
  });

  it("dedupes emission within the same minute via cursor", async () => {
    const reader = new SakanaUsageSynth({
      client: {
        fetchQuotaStatus(): Promise<QuotaStatusResponse> {
          return Promise.resolve(
            makeResponse([sakanaQuotaRow({ used_tokens: 250_000, quota_tokens: 1_000_000 })]),
          );
        },
      },
      now: (): Date => new Date("2026-06-23T12:34:30Z"),
    });

    const first = await reader.read(null);
    const second = await reader.read(first.cursor);

    expect(first.rate_limit_snapshots).toHaveLength(1);
    expect(second.rate_limit_snapshots).toHaveLength(0);
  });
});
