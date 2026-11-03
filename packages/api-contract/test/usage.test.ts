// Production mutations that would make these tests fail:
// 1. Remove .strict() from UsageRecentQuerySchema / UsageQuotaQuerySchema / UsageSubscriptionPressureQuerySchema
// 2. Remove z.iso.datetime() from since fields
// 3. Remove .min(1) from project_id/provider
// 4. Remove .coerce/.int/.positive/.max(86400) from stale_after_seconds
// 5. Change response schemas from .loose() to strict
import { describe, expect, test } from "bun:test";

import {
  UsageQuotaQuerySchema,
  UsageQuotaResponseSchema,
  UsageRecentQuerySchema,
  UsageRecentResponseSchema,
  UsageSubscriptionPressureQuerySchema,
  UsageSubscriptionPressureResponseSchema,
} from "../src/index.js";

describe("UsageRecentQuerySchema", () => {
  test("{} ok", () => {
    expect(UsageRecentQuerySchema.safeParse({}).success).toBe(true);
  });

  test('since "2026-11-03T00:00:00Z" ok', () => {
    expect(UsageRecentQuerySchema.safeParse({ since: "2026-11-03T00:00:00Z" }).success).toBe(true);
  });

  test('date-only "2026-11-03" fails', () => {
    expect(UsageRecentQuerySchema.safeParse({ since: "2026-11-03" }).success).toBe(false);
  });

  test("a non-ISO string fails", () => {
    expect(UsageRecentQuerySchema.safeParse({ since: "not-a-date" }).success).toBe(false);
  });

  test("project_id: null ok, 'p1' ok, '' fails", () => {
    expect(UsageRecentQuerySchema.safeParse({ project_id: null }).success).toBe(true);
    expect(UsageRecentQuerySchema.safeParse({ project_id: "p1" }).success).toBe(true);
    expect(UsageRecentQuerySchema.safeParse({ project_id: "" }).success).toBe(false);
  });

  test("unknown key fails (strict)", () => {
    const result = UsageRecentQuerySchema.safeParse({ unknown: 1 });
    expect(result.success).toBe(false);
  });
});

describe("UsageQuotaQuerySchema", () => {
  test("window accepts '24h'/'5h'/'7d' and rejects '1h'", () => {
    expect(UsageQuotaQuerySchema.safeParse({ window: "24h" }).success).toBe(true);
    expect(UsageQuotaQuerySchema.safeParse({ window: "5h" }).success).toBe(true);
    expect(UsageQuotaQuerySchema.safeParse({ window: "7d" }).success).toBe(true);
    expect(UsageQuotaQuerySchema.safeParse({ window: "1h" }).success).toBe(false);
  });

  test("since follows the same ISO rule", () => {
    expect(UsageQuotaQuerySchema.safeParse({ since: "2026-11-03T00:00:00Z" }).success).toBe(true);
    expect(UsageQuotaQuerySchema.safeParse({ since: "2026-11-03" }).success).toBe(false);
  });

  test("unknown key fails", () => {
    const result = UsageQuotaQuerySchema.safeParse({ extra: 1 });
    expect(result.success).toBe(false);
  });
});

describe("UsageSubscriptionPressureQuerySchema", () => {
  test("{} ok", () => {
    expect(UsageSubscriptionPressureQuerySchema.safeParse({}).success).toBe(true);
  });

  test('provider "" fails', () => {
    expect(UsageSubscriptionPressureQuerySchema.safeParse({ provider: "" }).success).toBe(false);
  });

  test('stale_after_seconds "60" gives the number 60', () => {
    const parsed = UsageSubscriptionPressureQuerySchema.parse({ stale_after_seconds: "60" });
    expect(parsed.stale_after_seconds).toBe(60);
  });

  test('"86400" ok, "86401" fails, "0" fails, "abc" fails', () => {
    expect(
      UsageSubscriptionPressureQuerySchema.safeParse({ stale_after_seconds: "86400" }).success,
    ).toBe(true);
    expect(
      UsageSubscriptionPressureQuerySchema.safeParse({ stale_after_seconds: "86401" }).success,
    ).toBe(false);
    expect(
      UsageSubscriptionPressureQuerySchema.safeParse({ stale_after_seconds: "0" }).success,
    ).toBe(false);
    expect(
      UsageSubscriptionPressureQuerySchema.safeParse({ stale_after_seconds: "abc" }).success,
    ).toBe(false);
  });

  test("unknown key fails", () => {
    const result = UsageSubscriptionPressureQuerySchema.safeParse({ extra: 1 });
    expect(result.success).toBe(false);
  });
});

describe("Response schemas (loose)", () => {
  const arbitrary = { rows: [1], total: 2 };

  test("UsageRecentResponseSchema parses arbitrary object and keeps keys", () => {
    const parsed = UsageRecentResponseSchema.parse(arbitrary);
    expect(parsed).toEqual(arbitrary);
  });

  test("UsageQuotaResponseSchema parses arbitrary object and keeps keys", () => {
    const parsed = UsageQuotaResponseSchema.parse(arbitrary);
    expect(parsed).toEqual(arbitrary);
  });

  test("UsageSubscriptionPressureResponseSchema parses arbitrary object and keeps keys", () => {
    const parsed = UsageSubscriptionPressureResponseSchema.parse(arbitrary);
    expect(parsed).toEqual(arbitrary);
  });

  test("non-object (null) fails", () => {
    expect(UsageRecentResponseSchema.safeParse(null).success).toBe(false);
    expect(UsageQuotaResponseSchema.safeParse(null).success).toBe(false);
    expect(UsageSubscriptionPressureResponseSchema.safeParse(null).success).toBe(false);
  });

  test("non-object (string) fails", () => {
    expect(UsageRecentResponseSchema.safeParse("x").success).toBe(false);
  });
});
