import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { UsageReader, UsageReaderResult, RateLimitDelta } from "./index.js";

export interface CodexRolloutReaderOptions {
  rootDir?: string;
  /** Only scan rollout files modified within the last N hours. Default 24. */
  lookbackHours?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface FileCursor {
  byte_offset: number;
  mtime_ms: number;
}
interface CodexRolloutCursor {
  files: Record<string, FileCursor>;
}

export class CodexRolloutReader implements UsageReader {
  readonly id = "codex-rollout";
  private rootDir: string;
  private lookbackHours: number;
  private now: () => number;

  constructor(opts: CodexRolloutReaderOptions = {}) {
    this.rootDir = opts.rootDir ?? join(homedir(), ".codex", "sessions");
    this.lookbackHours = opts.lookbackHours ?? 24;
    this.now = opts.now ?? (() => Date.now());
  }

  async read(previousCursor: unknown | null): Promise<UsageReaderResult> {
    if (!existsSync(this.rootDir)) {
      return {
        cursor: previousCursor ?? { files: {} },
        usage_deltas: [],
        rate_limit_snapshots: [],
      };
    }
    const cursor: CodexRolloutCursor = (previousCursor as CodexRolloutCursor | null) ?? {
      files: {},
    };
    const newCursor: CodexRolloutCursor = { files: { ...cursor.files } };

    const files = await this.listRolloutFiles();
    const allRateLimitSnapshots: RateLimitDelta[] = [];
    const cutoff = this.now() - this.lookbackHours * 60 * 60 * 1000;

    for (const filePath of files) {
      const fileCursor = newCursor.files[filePath];
      const stats = statSync(filePath);
      const { mtimeMs: mtime_ms, size } = stats;
      if (mtime_ms < cutoff) {
        continue;
      }
      if (fileCursor && fileCursor.mtime_ms === mtime_ms && fileCursor.byte_offset >= size) {
        continue;
      }
      const buf = readFileSync(filePath, "utf8");
      const start = fileCursor?.byte_offset ?? 0;
      const slice = buf.slice(start);

      let latestRateLimits: any = null;
      for (const rawLine of slice.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          obj?.type === "event_msg" &&
          obj?.payload?.type === "token_count" &&
          obj?.payload?.rate_limits
        ) {
          latestRateLimits = obj.payload.rate_limits;
        }
      }
      if (latestRateLimits) {
        for (const key of ["primary", "secondary"]) {
          const w = latestRateLimits[key];
          if (!w) continue;
          allRateLimitSnapshots.push({
            provider: this.canonicalizeProvider(latestRateLimits.limit_id),
            window_label: key,
            used_pct: Number(w.used_percent),
            window_minutes: typeof w.window_minutes === "number" ? w.window_minutes : undefined,
            resets_at: typeof w.resets_at === "number" ? w.resets_at : undefined,
            extra: { plan_type: latestRateLimits.plan_type, limit_id: latestRateLimits.limit_id },
          });
        }
      }
      newCursor.files[filePath] = { byte_offset: size, mtime_ms };
    }

    return { cursor: newCursor, usage_deltas: [], rate_limit_snapshots: allRateLimitSnapshots };
  }

  private async listRolloutFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = (dir: string) => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.isFile() && ent.name.startsWith("rollout-") && ent.name.endsWith(".jsonl"))
          out.push(p);
      }
    };
    walk(this.rootDir);
    return out;
  }

  private canonicalizeProvider(limit_id: string | undefined): string {
    if (!limit_id || limit_id === "codex") return "openai";
    return limit_id;
  }
}
