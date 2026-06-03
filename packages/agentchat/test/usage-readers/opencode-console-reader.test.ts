import { describe, expect, test } from "bun:test";
import {
  OpenCodeConsoleReader,
  parseUsageSnapshots,
} from "../../src/usage-readers/opencode-console-reader.js";

const NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const CONFIG = {
  workspace_id: "ws-1",
  base_url: "https://opencode.ai",
  cookie_file: "/tmp/oc.cookie",
};

function fixture(o: {
  rolling: string;
  weekly: string;
  monthly: string;
  rollingReset?: string;
  weeklyReset?: string;
  monthlyReset?: string;
}): string {
  const item = (label: string, value: string, reset: string) =>
    `<div data-slot="usage-item"><div data-slot="usage-header">` +
    `<span data-slot="usage-label">${label}</span>` +
    `<span data-slot="usage-value"><!--$-->${value}<!--/-->%</span></div>` +
    `<div data-slot="progress"><div data-slot="progress-bar" style="width:${value}%"></div></div>` +
    `<span data-slot="reset-time"><!--$-->Resets in<!--/--> <!--$-->${reset}<!--/--></span></div>`;
  return (
    `<main><div data-slot="usage">` +
    item("Rolling Usage", o.rolling, o.rollingReset ?? "5 hours 0 minutes") +
    item("Weekly Usage", o.weekly, o.weeklyReset ?? "5 days 3 hours") +
    item("Monthly Usage", o.monthly, o.monthlyReset ?? "24 days 15 hours") +
    `</div></main>`
  );
}

function mkReader(o: {
  html?: string;
  ok?: boolean;
  status?: number;
  redirected?: boolean;
  url?: string;
  cookie?: string | null;
}) {
  const calls: { url: string; init: { headers?: Record<string, string> } }[] = [];
  const reader = new OpenCodeConsoleReader(CONFIG, {
    now: () => NOW_MS,
    readCookieFile: async () => (o.cookie === undefined ? "session=abc" : o.cookie),
    fetch: (async (url: string, init: { headers?: Record<string, string> }) => {
      calls.push({ url, init });
      return {
        ok: o.ok ?? true,
        status: o.status ?? 200,
        redirected: o.redirected ?? false,
        url: o.url ?? "https://opencode.ai/workspace/ws-1/go",
        text: async () => o.html ?? "",
      };
    }) as unknown as typeof fetch,
  });
  return { reader, calls };
}

describe("OpenCodeConsoleReader", () => {
  test("fetches the console page with the cookie and parses three windows", async () => {
    const { reader, calls } = mkReader({
      html: fixture({ rolling: "0", weekly: "0", monthly: "0" }),
    });
    const res = await reader.read(null);
    expect(calls[0]?.url).toBe("https://opencode.ai/workspace/ws-1/go");
    expect(calls[0]?.init?.headers?.cookie).toBe("session=abc");
    expect(res.rate_limit_snapshots).toHaveLength(3);
    const pick = (label: string) => {
      const s = res.rate_limit_snapshots.find((x) => x.window_label === label);
      if (!s) throw new Error(`missing window ${label}`);
      return s;
    };
    expect(pick("five_hour").used_pct).toBe(0);
    expect(pick("five_hour").window_minutes).toBe(300);
    expect(pick("seven_day").window_minutes).toBe(10_080);
    expect(pick("thirty_day").window_minutes).toBe(43_200);
    expect(pick("five_hour").provider).toBe("opencode-go");
    expect(pick("five_hour").extra?.source_kind).toBe("opencode-console");
  });

  test("parses non-zero percentages and strips hydration markers", async () => {
    const { reader } = mkReader({ html: fixture({ rolling: "23", weekly: "45", monthly: "7" }) });
    const res = await reader.read(null);
    const byWindow = Object.fromEntries(
      res.rate_limit_snapshots.map((s) => [s.window_label, s.used_pct]),
    );
    expect(byWindow.five_hour).toBe(23);
    expect(byWindow.seven_day).toBe(45);
    expect(byWindow.thirty_day).toBe(7);
  });

  test("computes resets_at from relative reset text", async () => {
    const { reader } = mkReader({
      html: fixture({ rolling: "0", weekly: "0", monthly: "0", weeklyReset: "5 days 3 hours" }),
    });
    const res = await reader.read(null);
    const weekly = res.rate_limit_snapshots.find((s) => s.window_label === "seven_day");
    expect(weekly?.resets_at).toBe(NOW_S + 5 * 86_400 + 3 * 3_600);
  });

  test("returns no snapshot when the cookie is missing", async () => {
    const { reader } = mkReader({
      cookie: null,
      html: fixture({ rolling: "1", weekly: "1", monthly: "1" }),
    });
    expect((await reader.read(null)).rate_limit_snapshots).toEqual([]);
  });

  test("returns no snapshot on auth failure (non-ok)", async () => {
    const { reader } = mkReader({ ok: false, status: 401, html: "" });
    expect((await reader.read(null)).rate_limit_snapshots).toEqual([]);
  });

  test("returns no snapshot on a redirect to login", async () => {
    const { reader } = mkReader({
      ok: true,
      redirected: true,
      url: "https://opencode.ai/auth",
      html: "<html>login</html>",
    });
    expect((await reader.read(null)).rate_limit_snapshots).toEqual([]);
  });

  test("returns no snapshot when HTML lacks usage items", async () => {
    const { reader } = mkReader({ html: "<html><body>Sign in to continue</body></html>" });
    expect((await reader.read(null)).rate_limit_snapshots).toEqual([]);
  });

  test("parseUsageSnapshots maps labels to the three windows", () => {
    const snaps = parseUsageSnapshots(
      fixture({ rolling: "10", weekly: "20", monthly: "30" }),
      NOW_S,
    );
    expect(snaps.map((s) => s.window_label).sort()).toEqual([
      "five_hour",
      "seven_day",
      "thirty_day",
    ]);
  });
});
