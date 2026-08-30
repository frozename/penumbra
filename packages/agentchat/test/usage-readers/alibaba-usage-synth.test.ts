import { describe, expect, it } from "bun:test";

import type { QuotaStatusResponse } from "../../src/penumbra-client.js";

import { AlibabaUsageSynth } from "../../src/usage-readers/alibaba-usage-synth.js";

interface FetchQuotaArgs {
  since?: string;
  window?: "24h" | "5h" | "7d";
}

function makeResponse(rows: QuotaStatusResponse["providers"]): QuotaStatusResponse {
  return {
    window: { from: "2026-08-26T15:53:00Z", to: "2026-08-28T00:50:00Z" },
    providers: rows,
  };
}

function alibabaQuotaRow(args: {
  used_tokens: number;
  quota_tokens: number | null;
}): QuotaStatusResponse["providers"][number] {
  return {
    provider: "alibaba",
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

describe("AlibabaUsageSynth", () => {
  it("anchors pre-2026-09-02 reads to the previous fixed weekly window", async () => {
    const calls: FetchQuotaArgs[] = [];
    const reader = new AlibabaUsageSynth({
      client: {
        fetchQuotaStatus(args?: FetchQuotaArgs): Promise<QuotaStatusResponse> {
          calls.push(args ?? {});
          return Promise.resolve(
            makeResponse([alibabaQuotaRow({ used_tokens: 70, quota_tokens: 700 })]),
          );
        },
      },
      now: (): Date => new Date("2026-08-28T00:50:00Z"),
    });

    const out = await reader.read(null);

    expect(calls).toEqual([{ since: "2026-08-26T15:53:00.000Z", window: "7d" }]);
    expect(out.rate_limit_snapshots[0]?.resets_at).toBe(1_788_364_380);
    expect(out.rate_limit_snapshots[0]?.extra?.window_start).toBe("2026-08-26T15:53:00.000Z");
  });

  it("anchors post-2026-09-02 reads to the current fixed weekly window", async () => {
    const calls: FetchQuotaArgs[] = [];
    const reader = new AlibabaUsageSynth({
      client: {
        fetchQuotaStatus(args?: FetchQuotaArgs): Promise<QuotaStatusResponse> {
          calls.push(args ?? {});
          return Promise.resolve(
            makeResponse([alibabaQuotaRow({ used_tokens: 70, quota_tokens: 700 })]),
          );
        },
      },
      now: (): Date => new Date("2026-09-05T12:00:00Z"),
    });

    await reader.read(null);

    expect(calls).toEqual([{ since: "2026-09-02T15:53:00.000Z", window: "7d" }]);
  });

  it("treats the anchor boundary as the new window", async () => {
    const calls: FetchQuotaArgs[] = [];
    const reader = new AlibabaUsageSynth({
      client: {
        fetchQuotaStatus(args?: FetchQuotaArgs): Promise<QuotaStatusResponse> {
          calls.push(args ?? {});
          return Promise.resolve(
            makeResponse([alibabaQuotaRow({ used_tokens: 70, quota_tokens: 700 })]),
          );
        },
      },
      now: (): Date => new Date("2026-09-02T15:53:00Z"),
    });

    await reader.read(null);

    expect(calls).toEqual([{ since: "2026-09-02T15:53:00.000Z", window: "7d" }]);
  });

  it("emits one provider-level seven_day snapshot with derivation extras", async () => {
    const reader = new AlibabaUsageSynth({
      client: {
        fetchQuotaStatus(): Promise<QuotaStatusResponse> {
          return Promise.resolve(
            makeResponse([
              alibabaQuotaRow({ used_tokens: 1_750_000, quota_tokens: 7_000_000 }),
              {
                ...alibabaQuotaRow({ used_tokens: 6_000_000, quota_tokens: 7_000_000 }),
                model: "qwen3-coder-plus",
              },
            ]),
          );
        },
      },
      now: (): Date => new Date("2026-08-28T00:50:00Z"),
    });

    const out = await reader.read(null);

    expect(out.usage_deltas).toHaveLength(0);
    expect(out.rate_limit_snapshots).toEqual([
      {
        provider: "alibaba",
        window_label: "seven_day",
        used_pct: 25,
        window_minutes: 10_080,
        resets_at: 1_788_364_380,
        extra: {
          window_start: "2026-08-26T15:53:00.000Z",
          quota_tokens: 7_000_000,
          used_tokens: 1_750_000,
        },
      },
    ]);
  });

  it("dedupes emission within the same minute via cursor", async () => {
    const reader = new AlibabaUsageSynth({
      client: {
        fetchQuotaStatus(): Promise<QuotaStatusResponse> {
          return Promise.resolve(
            makeResponse([alibabaQuotaRow({ used_tokens: 1_750_000, quota_tokens: 7_000_000 })]),
          );
        },
      },
      now: (): Date => new Date("2026-08-28T00:50:30Z"),
    });

    const first = await reader.read(null);
    const second = await reader.read(first.cursor);

    expect(first.rate_limit_snapshots).toHaveLength(1);
    expect(second.rate_limit_snapshots).toHaveLength(0);
  });

  it.each([
    ["absent", null],
    ["zero", 0],
  ])("emits no snapshot when quota_tokens_per_7d is %s", async (_label, quota_tokens) => {
    const reader = new AlibabaUsageSynth({
      client: {
        fetchQuotaStatus(): Promise<QuotaStatusResponse> {
          return Promise.resolve(
            makeResponse([alibabaQuotaRow({ used_tokens: 1_750_000, quota_tokens })]),
          );
        },
      },
      now: (): Date => new Date("2026-08-28T00:50:00Z"),
    });

    const out = await reader.read(null);

    expect(out.rate_limit_snapshots).toHaveLength(0);
  });

  it("skips implausible ratios with one warning", async () => {
    const warnings: { meta: Record<string, unknown>; msg: string }[] = [];
    const reader = new AlibabaUsageSynth({
      client: {
        fetchQuotaStatus(): Promise<QuotaStatusResponse> {
          return Promise.resolve(
            makeResponse([alibabaQuotaRow({ used_tokens: 28_000_000, quota_tokens: 7_000_000 })]),
          );
        },
      },
      now: (): Date => new Date("2026-08-28T00:50:00Z"),
      max_plausible_pct: 300,
      warn: (meta, msg): number => warnings.push({ meta, msg }),
    });

    const first = await reader.read(null);
    const second = await reader.read(first.cursor);

    expect(first.rate_limit_snapshots).toHaveLength(0);
    expect(second.rate_limit_snapshots).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.meta).toMatchObject({
      provider: "alibaba",
      window_label: "seven_day",
      raw_used_pct: 400,
    });
  });
});
