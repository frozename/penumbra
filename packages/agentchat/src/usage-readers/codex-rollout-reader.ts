import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RateLimitDelta, UsageReader, UsageReaderResult } from "./index.js";

import {
  isRecord,
  numberFrom,
  parseJsonRecord,
  readNumber,
  readRecord,
  readString,
} from "./json-guards.js";

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
  model_provider?: string;
}
interface CodexRolloutCursor {
  files: Record<string, FileCursor>;
}

function readTail(filePath: string, offset: number, length: number): string {
  if (length <= 0) return "";
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(filePath, "r");
  let total = 0;
  try {
    while (total < length) {
      const n = fs.readSync(fd, buf, total, length - total, offset + total);
      if (n <= 0) break;
      total += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return buf.subarray(0, total).toString("utf8");
}

export class CodexRolloutReader implements UsageReader {
  readonly id = "codex-rollout";
  readonly machineGlobal = true;
  private rootDir: string;
  private lookbackHours: number;
  private now: () => number;

  constructor(opts: CodexRolloutReaderOptions = {}) {
    this.rootDir = opts.rootDir ?? join(homedir(), ".codex", "sessions");
    this.lookbackHours = opts.lookbackHours ?? 24;
    this.now = opts.now ?? ((): number => Date.now());
  }

  read(previousCursor: unknown): Promise<UsageReaderResult> {
    return Promise.resolve(this.readSync(previousCursor));
  }

  private readSync(previousCursor: unknown): UsageReaderResult {
    if (!fs.existsSync(this.rootDir)) {
      return {
        cursor: previousCursor ?? { files: {} },
        usage_deltas: [],
        rate_limit_snapshots: [],
      };
    }
    const cursor = normalizeCursor(previousCursor);
    const newCursor: CodexRolloutCursor = { files: { ...cursor.files } };

    const files = this.listRolloutFiles();
    const allRateLimitSnapshots: RateLimitDelta[] = [];
    const cutoff = this.now() - this.lookbackHours * 60 * 60 * 1000;

    for (const filePath of files) {
      const fileCursor = newCursor.files[filePath];
      const stats = fs.statSync(filePath);
      const { mtimeMs: mtime_ms, size } = stats;
      if (mtime_ms < cutoff) {
        continue;
      }
      const offset = fileCursor?.byte_offset ?? 0;
      if (offset >= size) {
        continue;
      }
      const slice = readTail(filePath, offset, size - offset);

      const scan = scanRolloutSlice(slice);
      const modelProvider = fileCursor?.model_provider ?? scan.modelProvider;
      if (scan.latestRateLimits) {
        allRateLimitSnapshots.push(
          ...this.buildRateLimitSnapshots(scan.latestRateLimits, modelProvider),
        );
      }
      newCursor.files[filePath] = {
        byte_offset: size,
        mtime_ms,
        ...(modelProvider ? { model_provider: modelProvider } : {}),
      };
    }

    return { cursor: newCursor, usage_deltas: [], rate_limit_snapshots: allRateLimitSnapshots };
  }

  private listRolloutFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
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

  private buildRateLimitSnapshots(
    latestRateLimits: Record<string, unknown>,
    modelProvider: string | undefined,
  ): RateLimitDelta[] {
    const snapshots: RateLimitDelta[] = [];
    const limitId = readString(latestRateLimits, "limit_id") ?? undefined;
    const provider = modelProvider?.length ? modelProvider : this.canonicalizeProvider(limitId);
    for (const key of ["primary", "secondary"] as const) {
      const windowState = readRecord(latestRateLimits, key);
      if (!windowState) continue;
      snapshots.push({
        provider,
        window_label: key,
        used_pct: numberFrom(windowState.used_percent),
        window_minutes: readNumber(windowState, "window_minutes") ?? undefined,
        resets_at: readNumber(windowState, "resets_at") ?? undefined,
        extra: {
          plan_type: readString(latestRateLimits, "plan_type"),
          limit_id: limitId,
        },
      });
    }
    return snapshots;
  }
}

function normalizeCursor(cursor: unknown): CodexRolloutCursor {
  if (!isRecord(cursor) || !isRecord(cursor.files)) return { files: {} };
  const files: Record<string, FileCursor> = {};
  for (const [path, value] of Object.entries(cursor.files)) {
    if (!isRecord(value)) continue;
    const modelProvider = normalizeModelProvider(readString(value, "model_provider"));
    files[path] = {
      byte_offset: numberFrom(value.byte_offset),
      mtime_ms: numberFrom(value.mtime_ms),
      ...(modelProvider ? { model_provider: modelProvider } : {}),
    };
  }
  return { files };
}

interface RolloutScanResult {
  latestRateLimits: Record<string, unknown> | null;
  modelProvider: string | undefined;
}

function scanRolloutSlice(slice: string): RolloutScanResult {
  let latestRateLimits: Record<string, unknown> | null = null;
  let modelProvider: string | undefined;
  for (const rawLine of slice.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const obj = parseJsonRecord(line);
    if (!obj) continue;
    const payload = readRecord(obj, "payload");
    if (!payload) continue;
    modelProvider ??= normalizeModelProvider(readString(payload, "model_provider"));
    const rateLimits = readTokenCountRateLimits(obj, payload);
    if (rateLimits) {
      latestRateLimits = rateLimits;
    }
  }
  return { latestRateLimits, modelProvider };
}

function normalizeModelProvider(value: string | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function readTokenCountRateLimits(
  obj: Record<string, unknown>,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  if (obj.type !== "event_msg" || payload.type !== "token_count") return null;
  return readRecord(payload, "rate_limits");
}
