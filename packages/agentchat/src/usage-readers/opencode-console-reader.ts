import { readCookieFile } from "./cookie-file.js";
import type { RateLimitDelta, UsageReader, UsageReaderResult } from "./index.js";

export interface OpenCodeConsoleReaderConfig {
  workspace_id: string;
  base_url: string;
  cookie_file: string;
}

export interface OpenCodeConsoleReaderDeps {
  fetch?: typeof fetch;
  readCookieFile?: (path: string) => Promise<string | null>;
  /** Current time in ms (testing). */
  now?: () => number;
}

interface OpenCodeConsoleCursor {
  last_fetched_at?: string;
}

const EMPTY = {
  usage_deltas: [],
  rate_limit_snapshots: [],
} satisfies Pick<UsageReaderResult, "usage_deltas" | "rate_limit_snapshots">;

const WINDOWS: Record<string, { window_label: string; window_minutes: number }> = {
  "rolling usage": { window_label: "five_hour", window_minutes: 300 },
  "weekly usage": { window_label: "seven_day", window_minutes: 10_080 },
  "monthly usage": { window_label: "thirty_day", window_minutes: 43_200 },
};

/**
 * Reads OpenCode-Go subscription usage from the web console at
 * {base_url}/workspace/{workspace_id}/go. OpenCode exposes no usage API for the
 * Go plan (only a 429 on exhaustion), so the server-rendered console page is the
 * sole source of the live rolling/weekly/monthly percentages. Auth is the user's
 * httpOnly session cookie, read from cookie_file on EVERY poll so rotation takes
 * effect without a restart. Degrades to no snapshot (never throws) when the cookie
 * is absent or the session has expired.
 */
export class OpenCodeConsoleReader implements UsageReader {
  readonly id = "opencode-console";
  private readonly config: OpenCodeConsoleReaderConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly readCookieFileImpl: (path: string) => Promise<string | null>;
  private readonly now: () => number;
  private warned = false;

  constructor(config: OpenCodeConsoleReaderConfig, deps: OpenCodeConsoleReaderDeps = {}) {
    this.config = config;
    this.fetchImpl = deps.fetch ?? fetch;
    this.readCookieFileImpl = deps.readCookieFile ?? readCookieFile;
    this.now = deps.now ?? (() => Date.now());
  }

  async read(previousCursor: unknown | null): Promise<UsageReaderResult> {
    const cursor = normalizeCursor(previousCursor);

    const cookie = await this.readCookieFileImpl(this.config.cookie_file);
    if (!cookie) {
      this.warnOnce(
        `opencode-console: no cookie at ${this.config.cookie_file} — paste the session cookie there`,
      );
      return { cursor, ...EMPTY };
    }

    const baseUrl = this.config.base_url.replace(/\/+$/, "");
    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl}/workspace/${this.config.workspace_id}/go`, {
        headers: { cookie, accept: "text/html" },
      });
    } catch {
      this.warnOnce("opencode-console: request failed");
      return { cursor, ...EMPTY };
    }
    if (!res.ok || isAuthRedirect(res)) {
      this.warnOnce(
        `opencode-console: auth failed (HTTP ${res.status}) — cookie at ${this.config.cookie_file} may be expired, re-paste it`,
      );
      return { cursor, ...EMPTY };
    }

    const html = await res.text().catch(() => "");
    const snapshots = parseUsageSnapshots(html, Math.floor(this.now() / 1000));
    if (snapshots.length === 0) {
      this.warnOnce(
        `opencode-console: no usage parsed — cookie at ${this.config.cookie_file} may be expired, re-paste it`,
      );
      return { cursor, ...EMPTY };
    }

    return {
      cursor: {
        last_fetched_at: new Date(this.now()).toISOString(),
      } satisfies OpenCodeConsoleCursor,
      usage_deltas: [],
      rate_limit_snapshots: snapshots,
    };
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(message);
  }
}

export function parseUsageSnapshots(html: string, nowSeconds: number): RateLimitDelta[] {
  const chunks = html.split('data-slot="usage-item"').slice(1);
  const snapshots: RateLimitDelta[] = [];
  for (const chunk of chunks) {
    const label = stripMarkup(
      capture(chunk, /data-slot="usage-label"[^>]*>([\s\S]*?)<\/span>/),
    ).toLowerCase();
    const win = WINDOWS[label];
    if (!win) continue;

    let usedPct = parsePct(
      stripMarkup(capture(chunk, /data-slot="usage-value"[^>]*>([\s\S]*?)<\/span>/)),
    );
    if (usedPct === null) {
      const width = capture(chunk, /data-slot="progress-bar"[^>]*style="[^"]*width:\s*([\d.]+)%/);
      usedPct = width ? clampPct(Number(width)) : null;
    }
    if (usedPct === null) continue;

    const resetText = stripMarkup(capture(chunk, /data-slot="reset-time"[^>]*>([\s\S]*?)<\/span>/));
    const resetSeconds = parseResetSeconds(resetText);

    snapshots.push({
      provider: "opencode-go",
      window_label: win.window_label,
      used_pct: clampPct(usedPct),
      window_minutes: win.window_minutes,
      resets_at: resetSeconds === null ? undefined : nowSeconds + resetSeconds,
      extra: { source_kind: "opencode-console" },
    });
  }
  return snapshots;
}

function capture(source: string, re: RegExp): string {
  const m = source.match(re);
  return m?.[1] ?? "";
}

function stripMarkup(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePct(value: string): number | null {
  const m = value.match(/(\d+(?:\.\d+)?)/);
  return m && m[1] !== undefined ? clampPct(Number(m[1])) : null;
}

function parseResetSeconds(text: string): number | null {
  const re = /(\d+)\s*(day|hour|minute|second)s?/gi;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matched = true;
    const n = Number(m[1] ?? "0");
    switch ((m[2] ?? "").toLowerCase()) {
      case "day":
        total += n * 86_400;
        break;
      case "hour":
        total += n * 3_600;
        break;
      case "minute":
        total += n * 60;
        break;
      default:
        total += n;
    }
  }
  return matched ? total : null;
}

function isAuthRedirect(res: Response): boolean {
  return Boolean(res.redirected) && /\/(auth|login|signin|sign-in)\b/.test(res.url ?? "");
}

function normalizeCursor(cursor: unknown | null): OpenCodeConsoleCursor {
  if (cursor && typeof cursor === "object" && "last_fetched_at" in cursor) {
    const v = (cursor as Record<string, unknown>).last_fetched_at;
    if (typeof v === "string") return { last_fetched_at: v };
  }
  return {};
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}
