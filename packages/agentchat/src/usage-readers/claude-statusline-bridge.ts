import { existsSync, readFileSync, statSync } from "node:fs";

import type { RateLimitDelta, UsageReader, UsageReaderResult } from "./index.js";

import { isRecord, numberFrom, parseJsonRecord, readNumber, readRecord } from "./json-guards.js";

export interface ClaudeStatusLineBridgeOptions {
  cachePath?: string;
}

interface BridgeCursor {
  last_seen_mtime_ms: number;
}

const DEFAULT_CACHE_PATH = process.env.PENUMBRA_CLAUDE_RL_PATH ?? "/tmp/penumbra-claude-rl.json";

export class ClaudeStatusLineBridge implements UsageReader {
  readonly id = "claude-statusline";
  readonly machineGlobal = true;
  private cachePath: string;

  constructor(opts: ClaudeStatusLineBridgeOptions = {}) {
    this.cachePath = opts.cachePath ?? DEFAULT_CACHE_PATH;
  }

  read(previousCursor: unknown): Promise<UsageReaderResult> {
    return Promise.resolve(this.readSync(previousCursor));
  }

  private readSync(previousCursor: unknown): UsageReaderResult {
    if (!existsSync(this.cachePath)) {
      return {
        cursor: previousCursor ?? { last_seen_mtime_ms: 0 },
        usage_deltas: [],
        rate_limit_snapshots: [],
      };
    }

    const cursor = normalizeCursor(previousCursor);
    const stats = statSync(this.cachePath);
    if (stats.mtimeMs <= cursor.last_seen_mtime_ms) {
      return { cursor, usage_deltas: [], rate_limit_snapshots: [] };
    }

    const body = parseJsonRecord(readFileSync(this.cachePath, "utf8"));
    if (!body) {
      return {
        cursor: { last_seen_mtime_ms: stats.mtimeMs },
        usage_deltas: [],
        rate_limit_snapshots: [],
      };
    }

    const snapshots: RateLimitDelta[] = [];
    for (const key of ["five_hour", "seven_day"]) {
      const windowState = readRecord(body, key);
      if (!windowState) continue;
      const used_pct = numberFrom(windowState.used_percentage ?? windowState.utilization, NaN);
      if (!Number.isFinite(used_pct)) continue;
      snapshots.push({
        provider: "anthropic",
        window_label: key,
        used_pct,
        resets_at: readNumber(windowState, "resets_at") ?? undefined,
      });
    }

    return {
      cursor: { last_seen_mtime_ms: stats.mtimeMs },
      usage_deltas: [],
      rate_limit_snapshots: snapshots,
    };
  }
}

function normalizeCursor(cursor: unknown): BridgeCursor {
  if (!isRecord(cursor)) return { last_seen_mtime_ms: 0 };
  return { last_seen_mtime_ms: numberFrom(cursor.last_seen_mtime_ms) };
}
