import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RateLimitDelta, UsageReader, UsageReaderResult } from "./index.js";

export interface OpenCodeApiReaderOptions {
  dbPath?: string;
  fetch?: typeof fetch;
}

interface OpenCodeApiCursor {
  last_fetched_at?: string;
}

interface ActiveAccount {
  id: string;
  url: string;
  access_token: string;
  active_org_id: string | null;
}

const EMPTY_RESULT = {
  usage_deltas: [],
  rate_limit_snapshots: [],
} satisfies Pick<UsageReaderResult, "usage_deltas" | "rate_limit_snapshots">;

export class OpenCodeApiReader implements UsageReader {
  readonly id = "opencode-api";
  private readonly dbPath: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenCodeApiReaderOptions = {}) {
    this.dbPath = opts.dbPath ?? join(homedir(), ".local", "share", "opencode", "opencode.db");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async read(previousCursor: unknown | null): Promise<UsageReaderResult> {
    const cursor = normalizeCursor(previousCursor);
    const account = readActiveAccount(this.dbPath);
    if (!account || !account.active_org_id) {
      return { cursor, ...EMPTY_RESULT };
    }

    const response = await this.fetchImpl(`${account.url.replace(/\/+$/, "")}/api/config`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${account.access_token}`,
        "x-org-id": account.active_org_id,
      },
    }).catch(() => null);
    if (!response?.ok) {
      return { cursor, ...EMPTY_RESULT };
    }

    const body = await response.json().catch(() => null);
    const snapshots = parseUsageSnapshots(body);
    if (snapshots.length === 0) {
      return { cursor, ...EMPTY_RESULT };
    }

    return {
      cursor: { last_fetched_at: new Date().toISOString() } satisfies OpenCodeApiCursor,
      usage_deltas: [],
      rate_limit_snapshots: snapshots,
    };
  }
}

function readActiveAccount(dbPath: string): ActiveAccount | null {
  if (!existsSync(dbPath)) return null;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        `SELECT a.id, a.url, a.access_token, s.active_org_id
         FROM account_state s
         JOIN account a ON a.id = s.active_account_id
         WHERE s.id = 1
         LIMIT 1`,
      )
      .get() as ActiveAccount | undefined;
    if (!row?.id || !row.url || !row.access_token) return null;
    return row;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function parseUsageSnapshots(body: unknown): RateLimitDelta[] {
  const provider = getPath(body, ["config", "providers", "opencode-go"]);
  const usage = isRecord(provider) ? provider.usage : undefined;
  if (!isRecord(usage)) return [];

  const windows = [
    { label: "five_hour", aliases: ["five_hour", "fiveHour", "5h"], minutes: 300 },
    { label: "seven_day", aliases: ["seven_day", "sevenDay", "7d", "weekly"], minutes: 10080 },
    { label: "thirty_day", aliases: ["thirty_day", "thirtyDay", "30d", "monthly"], minutes: 43200 },
  ] as const;

  const snapshots: RateLimitDelta[] = [];
  for (const window of windows) {
    const raw = firstRecord(usage, window.aliases);
    if (!raw) continue;

    const usedPct = extractUsedPct(raw);
    if (usedPct == null) continue;

    snapshots.push({
      provider: "opencode-go",
      window_label: window.label,
      used_pct: usedPct,
      window_minutes: window.minutes,
      resets_at: extractUnixSeconds(raw, ["resets_at", "reset_at", "resetAt", "reset"]),
      extra: { source_kind: "opencode-api" },
    });
  }
  return snapshots;
}

function extractUsedPct(raw: Record<string, unknown>): number | null {
  const direct = extractNumber(raw, ["used_pct", "usedPct", "percent", "percentage"]);
  if (direct != null) return clampPct(direct);

  const used = extractNumber(raw, ["used", "used_usd", "usedUsd"]);
  const limit = extractNumber(raw, ["limit", "quota", "quota_usd", "quotaUsd"]);
  if (used == null || limit == null || limit <= 0) return null;
  return clampPct((used / limit) * 100);
}

function extractUnixSeconds(raw: Record<string, unknown>, keys: string[]): number | undefined {
  const value = extractNumber(raw, keys);
  if (value == null || value <= 0) return undefined;
  return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
}

function extractNumber(raw: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = raw[key];
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function firstRecord(raw: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const value = raw[key];
    if (isRecord(value)) return value;
  }
  return null;
}

function getPath(raw: unknown, path: string[]): unknown {
  let current = raw;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCursor(cursor: unknown | null): OpenCodeApiCursor {
  if (!isRecord(cursor)) return {};
  return typeof cursor.last_fetched_at === "string" ? { last_fetched_at: cursor.last_fetched_at } : {};
}

function clampPct(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}
