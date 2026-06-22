import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { UsageReader, UsageReaderDelta, UsageReaderResult } from "./index.js";

import { isRecord, numberFrom, parseJsonRecord, readRecord, readString } from "./json-guards.js";

export interface OpenCodeDbReaderOptions {
  dbPath?: string;
}

interface OpenCodeDbCursor {
  last_seen_time_created: number;
}

export class OpenCodeDbReader implements UsageReader {
  readonly id = "opencode-db";
  readonly machineGlobal = true;
  private dbPath: string;

  constructor(opts: OpenCodeDbReaderOptions = {}) {
    this.dbPath = opts.dbPath ?? join(homedir(), ".local", "share", "opencode", "opencode.db");
  }

  read(previousCursor: unknown): Promise<UsageReaderResult> {
    return Promise.resolve(this.readSync(previousCursor));
  }

  private readSync(previousCursor: unknown): UsageReaderResult {
    if (!existsSync(this.dbPath)) {
      return {
        cursor: previousCursor ?? { last_seen_time_created: 0 },
        usage_deltas: [],
        rate_limit_snapshots: [],
      };
    }
    const cursor = normalizeCursor(previousCursor);
    let db: Database | undefined;
    try {
      db = new Database(this.dbPath, { readonly: true });
      db.run("PRAGMA busy_timeout = 3000");

      const rows = db
        .prepare(
          'SELECT id, time_created, data FROM message WHERE time_created > ? AND json_extract(data, "$.role") = "assistant" ORDER BY time_created ASC',
        )
        .all(cursor.last_seen_time_created) as {
        id: string;
        time_created: number;
        data: string;
      }[];

      const { buckets, maxTimeCreated } = collectRows(rows, cursor.last_seen_time_created);

      return {
        cursor: { last_seen_time_created: maxTimeCreated } satisfies OpenCodeDbCursor,
        usage_deltas: [...buckets.values()],
        rate_limit_snapshots: [],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("database is locked")) {
        console.warn(`opencode-db reader: ${message}; returning empty cycle`);
        return {
          cursor: cursor,
          usage_deltas: [],
          rate_limit_snapshots: [],
        };
      }
      throw err;
    } finally {
      db?.close();
    }
  }
}

function normalizeCursor(cursor: unknown): OpenCodeDbCursor {
  if (!isRecord(cursor)) return { last_seen_time_created: 0 };
  return { last_seen_time_created: numberFrom(cursor.last_seen_time_created) };
}

function collectRows(
  rows: { id: string; time_created: number; data: string }[],
  lastSeenTimeCreated: number,
): { buckets: Map<string, UsageReaderDelta>; maxTimeCreated: number } {
  const buckets = new Map<string, UsageReaderDelta>();
  let maxTimeCreated = lastSeenTimeCreated;
  for (const row of rows) {
    const body = parseJsonRecord(row.data);
    const tokens = body ? readRecord(body, "tokens") : null;
    if (!body || !tokens) continue;
    const provider = readString(body, "providerID") ?? "unknown";
    const model = readString(body, "modelID");
    const bucket = getBucket(buckets, provider, model, row.time_created);
    const cache = readRecord(tokens, "cache");
    bucket.tokens_input += numberFrom(tokens.input);
    bucket.tokens_output += numberFrom(tokens.output);
    bucket.tokens_cache_read = (bucket.tokens_cache_read ?? 0) + numberFrom(cache?.read);
    bucket.tokens_cache_write = (bucket.tokens_cache_write ?? 0) + numberFrom(cache?.write);
    bucket.cost_usd = (bucket.cost_usd ?? 0) + numberFrom(body.cost);
    bucket.window_end = new Date(row.time_created).toISOString();
    if (row.time_created > maxTimeCreated) maxTimeCreated = row.time_created;
  }
  return { buckets, maxTimeCreated };
}

function getBucket(
  buckets: Map<string, UsageReaderDelta>,
  provider: string,
  model: string | null,
  timeCreated: number,
): UsageReaderDelta {
  const key = `${provider}\0${model ?? ""}`;
  const existing = buckets.get(key);
  if (existing) return existing;
  const ts = new Date(timeCreated).toISOString();
  const bucket: UsageReaderDelta = {
    provider,
    model,
    tokens_input: 0,
    tokens_output: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    cost_usd: 0,
    window_start: ts,
    window_end: ts,
  };
  buckets.set(key, bucket);
  return bucket;
}
