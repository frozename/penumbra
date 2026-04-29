import { existsSync, readFileSync, statSync } from 'node:fs';
import type { UsageReader, UsageReaderResult, RateLimitDelta } from './index.js';

export interface ClaudeStatusLineBridgeOptions {
  cachePath?: string;
}

interface BridgeCursor {
  last_seen_mtime_ms: number;
}

const DEFAULT_CACHE_PATH = process.env.PENUMBRA_CLAUDE_RL_PATH ?? '/tmp/penumbra-claude-rl.json';

export class ClaudeStatusLineBridge implements UsageReader {
  readonly id = 'claude-statusline';
  private cachePath: string;

  constructor(opts: ClaudeStatusLineBridgeOptions = {}) {
    this.cachePath = opts.cachePath ?? DEFAULT_CACHE_PATH;
  }

  async read(previousCursor: unknown | null): Promise<UsageReaderResult> {
    if (!existsSync(this.cachePath)) {
      return {
        cursor: previousCursor ?? { last_seen_mtime_ms: 0 },
        usage_deltas: [],
        rate_limit_snapshots: [],
      };
    }

    const cursor: BridgeCursor = (previousCursor as BridgeCursor | null) ?? { last_seen_mtime_ms: 0 };
    const stats = statSync(this.cachePath);
    if (stats.mtimeMs <= cursor.last_seen_mtime_ms) {
      return { cursor, usage_deltas: [], rate_limit_snapshots: [] };
    }

    let body: any;
    try {
      body = JSON.parse(readFileSync(this.cachePath, 'utf8'));
    } catch {
      return {
        cursor: { last_seen_mtime_ms: stats.mtimeMs },
        usage_deltas: [],
        rate_limit_snapshots: [],
      };
    }

    const snapshots: RateLimitDelta[] = [];
    for (const key of ['five_hour', 'seven_day']) {
      const windowState = body?.[key];
      if (!windowState) continue;
      const used_pct = Number(windowState.used_percentage ?? windowState.utilization);
      if (!Number.isFinite(used_pct)) continue;
      snapshots.push({
        provider: 'anthropic',
        window_label: key,
        used_pct,
        resets_at: typeof windowState.resets_at === 'number' ? windowState.resets_at : undefined,
      });
    }

    return {
      cursor: { last_seen_mtime_ms: stats.mtimeMs },
      usage_deltas: [],
      rate_limit_snapshots: snapshots,
    };
  }
}
