import { describe, expect, test } from "bun:test";

import {
  computeAgeDays,
  STALE_AFTER_DAYS_BY_OBS_TYPE,
  STALE_AFTER_DAYS_DEFAULT,
  staleThresholdDays,
} from "@src/schemas/recall.js";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-06-01T00:00:00.000Z");

function isoAgo(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

// Mirrors the readers (search.ts, timeline.ts, get-observations.ts):
// stale = ageDays === null ? true : ageDays >= staleThresholdDays(obs_type)
function isStale(obsType: string | null, ageDays: number): boolean {
  const age = computeAgeDays(NOW, isoAgo(ageDays * DAY_MS), null);
  return age === null ? true : age >= staleThresholdDays(obsType);
}

describe("staleThresholdDays", () => {
  test("returns the 30-day default for null, undefined and the empty string", () => {
    expect(STALE_AFTER_DAYS_DEFAULT).toBe(30);
    expect(staleThresholdDays(null)).toBe(STALE_AFTER_DAYS_DEFAULT);
    expect(staleThresholdDays(undefined)).toBe(STALE_AFTER_DAYS_DEFAULT);
    expect(staleThresholdDays("")).toBe(STALE_AFTER_DAYS_DEFAULT);
  });

  const thresholds: (readonly [string, number])[] = [
    ["decision", 180],
    ["security_alert", 365],
    ["security_note", 365],
    ["bugfix", 60],
    ["feature", 60],
    ["refactor", 60],
    ["discovery", 30],
  ];
  for (const [obsType, days] of thresholds) {
    test(`maps ${obsType} to ${String(days)} days`, () => {
      expect(staleThresholdDays(obsType)).toBe(days);
    });
  }

  test("overrides exactly six obs types", () => {
    expect(STALE_AFTER_DAYS_BY_OBS_TYPE).toEqual({
      decision: 180,
      security_alert: 365,
      security_note: 365,
      bugfix: 60,
      feature: 60,
      refactor: 60,
    });
  });
});

describe("computeAgeDays", () => {
  const ages: (readonly [string, number, number | null, number])[] = [
    ["10 days since createdAt", 10 * DAY_MS, null, 10],
    ["lastVerifiedAt 2 days ago wins over createdAt 100 days ago", 100 * DAY_MS, 2 * DAY_MS, 2],
    ["23h59m rounds down to 0", DAY_MS - 60_000, null, 0],
    ["exactly 86_400_000 ms is 1 day", DAY_MS, null, 1],
    ["30 days minus one minute rounds down to 29", 30 * DAY_MS - 60_000, null, 29],
    ["a createdAt one day in the future clamps to 0", -DAY_MS, null, 0],
  ];
  for (const [name, createdAgoMs, verifiedAgoMs, expected] of ages) {
    test(name, () => {
      const verifiedAt = verifiedAgoMs === null ? null : isoAgo(verifiedAgoMs);
      expect(computeAgeDays(NOW, isoAgo(createdAgoMs), verifiedAt)).toBe(expected);
    });
  }

  test("returns null for an unparseable createdAt with no lastVerifiedAt", () => {
    expect(computeAgeDays(NOW, "not-a-date", null)).toBeNull();
  });
});

describe("stale boundary as the readers compose it", () => {
  const boundaries: (readonly [string | null, number, boolean])[] = [
    [null, 29, false],
    [null, 30, true],
    ["bugfix", 59, false],
    ["bugfix", 60, true],
    ["decision", 179, false],
    ["decision", 180, true],
    ["security_alert", 364, false],
    ["security_alert", 365, true],
  ];
  for (const [obsType, ageDays, stale] of boundaries) {
    test(`${obsType ?? "null obs_type"} at ${String(ageDays)} days is ${stale ? "stale" : "fresh"}`, () => {
      expect(isStale(obsType, ageDays)).toBe(stale);
    });
  }
});
