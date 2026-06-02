import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { UsageReader, UsageReaderResult, UsageReaderDelta, RateLimitDelta } from "./index.js";

export interface OpenCodeDbReaderOptions {
  dbPath?: string;
  budgets?: {
    five_hour?: number;
    seven_day?: number;
    thirty_day?: number;
  };
}

interface OpenCodeDbCursor {
  last_seen_time_created: number;
}

export class OpenCodeDbReader implements UsageReader {
  readonly id = "opencode-db";
  private dbPath: string;
  private budgets: { five_hour: number; seven_day: number; thirty_day: number };

  constructor(opts: OpenCodeDbReaderOptions = {}) {
    this.dbPath = opts.dbPath ?? join(homedir(), ".local", "share", "opencode", "opencode.db");
    this.budgets = {
      five_hour: opts.budgets?.five_hour ?? 12,
      seven_day: opts.budgets?.seven_day ?? 30,
      thirty_day: opts.budgets?.thirty_day ?? 60,
    };
  }

  async read(previousCursor: unknown | null): Promise<UsageReaderResult> {
    if (!existsSync(this.dbPath)) {
      return {
        cursor: previousCursor ?? { last_seen_time_created: 0 },
        usage_deltas: [],
        rate_limit_snapshots: [],
      };
    }
    const cursor: OpenCodeDbCursor = (previousCursor as OpenCodeDbCursor | null) ?? {
      last_seen_time_created: 0,
    };
    const db = new Database(this.dbPath, { readonly: true });

    const rows = db
      .prepare(
        'SELECT id, time_created, data FROM message WHERE time_created > ? AND json_extract(data, "$.role") = "assistant" ORDER BY time_created ASC',
      )
      .all(cursor.last_seen_time_created) as Array<{
      id: string;
      time_created: number;
      data: string;
    }>;

    const buckets = new Map<string, UsageReaderDelta>();
    let max_tc = cursor.last_seen_time_created;
    for (const row of rows) {
      let body: any;
      try {
        body = JSON.parse(row.data);
      } catch {
        continue;
      }
      const tokens = body?.tokens;
      if (!tokens || typeof tokens !== "object") continue;
      const provider = String(body.providerID ?? "unknown");
      const model = body.modelID ?? null;
      const key = `${provider}\0${model ?? ""}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          provider,
          model,
          tokens_input: 0,
          tokens_output: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          cost_usd: 0,
          window_start: new Date(row.time_created).toISOString(),
          window_end: new Date(row.time_created).toISOString(),
        };
        buckets.set(key, bucket);
      }
      bucket.tokens_input += Number(tokens.input ?? 0);
      bucket.tokens_output += Number(tokens.output ?? 0);
      bucket.tokens_cache_read = (bucket.tokens_cache_read ?? 0) + Number(tokens.cache?.read ?? 0);
      bucket.tokens_cache_write =
        (bucket.tokens_cache_write ?? 0) + Number(tokens.cache?.write ?? 0);
      bucket.cost_usd = (bucket.cost_usd ?? 0) + Number(body.cost ?? 0);
      bucket.window_end = new Date(row.time_created).toISOString();
      if (row.time_created > max_tc) max_tc = row.time_created;
    }

    const nowMs = Date.now();
    const durations = {
      five_hour: 5 * 3600 * 1000,
      seven_day: 7 * 86400 * 1000,
      thirty_day: 30 * 86400 * 1000,
    };

    const snapshotRows = db
      .prepare(
        'SELECT time_created, json_extract(data, "$.cost") as cost FROM message WHERE time_created > ? AND json_extract(data, "$.role") = "assistant" AND json_extract(data, "$.providerID") = "opencode-go"',
      )
      .all(nowMs - durations.thirty_day) as Array<{ time_created: number; cost: number | null }>;

    db.close();

    let cost5h = 0;
    let cost7d = 0;
    let cost30d = 0;

    let minTc5h = nowMs;
    let minTc7d = nowMs;
    let minTc30d = nowMs;

    for (const row of snapshotRows) {
      const cost = Number(row.cost ?? 0);
      if (cost <= 0) continue;

      const tc = row.time_created;

      if (tc > nowMs - durations.five_hour) {
        cost5h += cost;
        if (tc < minTc5h) minTc5h = tc;
      }

      if (tc > nowMs - durations.seven_day) {
        cost7d += cost;
        if (tc < minTc7d) minTc7d = tc;
      }

      cost30d += cost;
      if (tc < minTc30d) minTc30d = tc;
    }

    const rate_limit_snapshots: RateLimitDelta[] = [];

    const pushSnapshot = (
      label: string,
      cost: number,
      budget: number,
      minTc: number,
      dur: number,
    ) => {
      let used_pct = (cost / budget) * 100;
      if (used_pct < 0) used_pct = 0;
      if (used_pct > 100) used_pct = 100;

      const resets_at = Math.floor((minTc + dur) / 1000);

      rate_limit_snapshots.push({
        provider: "opencode-go",
        window_label: label,
        used_pct,
        resets_at,
        extra: { source_kind: "local-state-opencode-db" },
      });
    };

    pushSnapshot(
      "five_hour",
      cost5h,
      this.budgets.five_hour,
      cost5h > 0 ? minTc5h : nowMs,
      durations.five_hour,
    );
    pushSnapshot(
      "seven_day",
      cost7d,
      this.budgets.seven_day,
      cost7d > 0 ? minTc7d : nowMs,
      durations.seven_day,
    );
    pushSnapshot(
      "thirty_day",
      cost30d,
      this.budgets.thirty_day,
      cost30d > 0 ? minTc30d : nowMs,
      durations.thirty_day,
    );

    return {
      cursor: { last_seen_time_created: max_tc } satisfies OpenCodeDbCursor,
      usage_deltas: [...buckets.values()],
      rate_limit_snapshots,
    };
  }
}
