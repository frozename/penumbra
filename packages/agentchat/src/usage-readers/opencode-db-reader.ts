import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { UsageReader, UsageReaderResult, UsageReaderDelta } from "./index.js";

export interface OpenCodeDbReaderOptions {
  dbPath?: string;
}

interface OpenCodeDbCursor {
  last_seen_time_created: number;
}

export class OpenCodeDbReader implements UsageReader {
  readonly id = "opencode-db";
  private dbPath: string;

  constructor(opts: OpenCodeDbReaderOptions = {}) {
    this.dbPath = opts.dbPath ?? join(homedir(), ".local", "share", "opencode", "opencode.db");
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

    db.close();

    return {
      cursor: { last_seen_time_created: max_tc } satisfies OpenCodeDbCursor,
      usage_deltas: [...buckets.values()],
      rate_limit_snapshots: [],
    };
  }
}
