import { describe, expect, it } from "bun:test";

import { parseDuration, runCostQuota, runCostRecent } from "@src/commands/cost.js";

describe("parseDuration", () => {
  it("parses Nh", () => {
    expect(parseDuration("24h")).toBe(24 * 60 * 60 * 1000);
  });
  it("parses Nm", () => {
    expect(parseDuration("30m")).toBe(30 * 60 * 1000);
  });
  it("parses Nd", () => {
    expect(parseDuration("2d")).toBe(2 * 24 * 60 * 60 * 1000);
  });
});

describe("runCostRecent", () => {
  it("--json prints raw RecentCostOutput shape", async () => {
    let printed = "";
    await runCostRecent({
      since: "24h",
      json: true,
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              total_cost_usd: 0.42,
              total_tokens_used: 100,
              handoff_count: 1,
              by_provider: [],
              window: { from: "a", to: "b" },
            }),
            { status: 200 },
          ),
        ),
      print: (s: string) => {
        printed = s;
      },
    });
    const parsed = JSON.parse(printed) as { total_cost_usd: number };
    expect(parsed.total_cost_usd).toBe(0.42);
  });
});

describe("runCostQuota", () => {
  it("prints a table with providers", async () => {
    let printed = "";
    await runCostQuota({
      since: undefined,
      json: false,
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              window: { from: "x", to: "y" },
              providers: [
                {
                  provider: "anthropic",
                  used_usd: 12.4,
                  quota_usd: 50,
                  remaining_usd: 37.6,
                  remaining_pct_usd: 75.2,
                  used_tokens: 0,
                  quota_tokens: null,
                  remaining_tokens: null,
                  remaining_pct_tokens: null,
                },
              ],
            }),
            { status: 200 },
          ),
        ),
      print: (s: string) => {
        printed += s + "\n";
      },
    });
    expect(printed).toContain("anthropic");
    expect(printed).toContain("75.2");
  });

  it("shows provider/model label when model is set on the row", async () => {
    let printed = "";
    await runCostQuota({
      since: undefined,
      json: false,
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              window: { from: "x", to: "y" },
              providers: [
                {
                  provider: "google",
                  used_usd: 0,
                  quota_usd: 25,
                  remaining_usd: 25,
                  remaining_pct_usd: 100,
                  used_tokens: 0,
                  quota_tokens: null,
                  remaining_tokens: null,
                  remaining_pct_tokens: null,
                },
                {
                  provider: "google",
                  model: "gemini-3-flash-preview",
                  used_usd: null,
                  quota_usd: null,
                  remaining_usd: null,
                  remaining_pct_usd: null,
                  used_tokens: 21849,
                  quota_tokens: 1500000,
                  remaining_tokens: 1478151,
                  remaining_pct_tokens: 98.5,
                },
                {
                  provider: "google",
                  model: "gemini-3.1-pro-preview",
                  used_usd: null,
                  quota_usd: null,
                  remaining_usd: null,
                  remaining_pct_usd: null,
                  used_tokens: 0,
                  quota_tokens: 250000,
                  remaining_tokens: 250000,
                  remaining_pct_tokens: 100,
                },
              ],
            }),
            { status: 200 },
          ),
        ),
      print: (s: string) => {
        printed += s + "\n";
      },
    });
    expect(printed).toContain("google/gemini-3-flash-preview");
    expect(printed).toContain("google/gemini-3.1-pro-preview");
    expect(printed).toContain("21849 / 1500000");
    expect(printed).toContain("98.5");
    // Provider-level row still shows just "google" (no slash)
    const lines = printed.split("\n").filter((l: string) => l.includes("google"));
    expect(lines.some((l: string) => /google\s+\$/.test(l))).toBe(true);
  });
});
