import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { UsageReader, UsageReaderDelta, UsageReaderResult } from "./index.js";

import { isRecord, numberFrom, parseJsonRecord, readRecord, readString } from "./json-guards.js";

export interface ClaudeJsonlReaderOptions {
  rootDir?: string;
  /** Only scan jsonl files modified within the last N hours. Default 24. */
  lookbackHours?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface FileCursor {
  byte_offset: number;
  mtime_ms: number;
}
interface ClaudeJsonlCursor {
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

export class ClaudeJsonlReader implements UsageReader {
  readonly id = "claude-jsonl";
  readonly machineGlobal = true;
  private rootDir: string;
  private lookbackHours: number;
  private now: () => number;

  constructor(opts: ClaudeJsonlReaderOptions = {}) {
    this.rootDir = opts.rootDir ?? join(homedir(), ".claude", "projects");
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
    const newCursor: ClaudeJsonlCursor = { files: { ...cursor.files } };
    const cutoff = this.now() - this.lookbackHours * 60 * 60 * 1000;
    const seenInWindow = new Set<string>();

    const buckets = new Map<string, UsageReaderDelta>();
    const projectDirs = fs
      .readdirSync(this.rootDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    for (const projDir of projectDirs) {
      this.readProjectDir(projDir.name, cutoff, seenInWindow, newCursor, buckets);
    }

    newCursor.files = Object.fromEntries(
      Object.entries(newCursor.files).filter(([path]) => seenInWindow.has(path)),
    );
    /**
     * Claude rate limits intentionally NOT captured here. The canonical source is
     * `ClaudeStatusLineBridge` (see ./claude-statusline-bridge.ts), which reads
     * /tmp/penumbra-claude-rl.json — written by the user's statusline hook from
     * Claude session JSON's `.rate_limits` field. This reader covers per-message
     * token usage only; `ClaudeStatusLineBridge` is the canonical rate-limit source.
     */
    return { cursor: newCursor, usage_deltas: [...buckets.values()], rate_limit_snapshots: [] };
  }

  private readProjectDir(
    projectDirName: string,
    cutoff: number,
    seenInWindow: Set<string>,
    newCursor: ClaudeJsonlCursor,
    buckets: Map<string, UsageReaderDelta>,
  ): void {
    const projectPath = join(this.rootDir, projectDirName);
    let files: import("node:fs").Dirent[];
    try {
      files = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const fEnt of files) {
      this.readProjectFile(projectPath, fEnt, cutoff, seenInWindow, newCursor, buckets);
    }
  }

  private readProjectFile(
    projectPath: string,
    fEnt: import("node:fs").Dirent,
    cutoff: number,
    seenInWindow: Set<string>,
    newCursor: ClaudeJsonlCursor,
    buckets: Map<string, UsageReaderDelta>,
  ): void {
    if (!fEnt.isFile() || !fEnt.name.endsWith(".jsonl")) return;
    const filePath = join(projectPath, fEnt.name);
    const stats = fs.statSync(filePath);
    if (stats.mtimeMs < cutoff) return;
    seenInWindow.add(filePath);
    const offset = newCursor.files[filePath]?.byte_offset ?? 0;
    if (offset < stats.size) {
      accumulateUsage(readTail(filePath, offset, stats.size - offset), buckets);
    }
    newCursor.files[filePath] = { byte_offset: stats.size, mtime_ms: stats.mtimeMs };
  }
}

function normalizeCursor(cursor: unknown): ClaudeJsonlCursor {
  if (!isRecord(cursor) || !isRecord(cursor.files)) return { files: {} };
  const files: Record<string, FileCursor> = {};
  for (const [path, value] of Object.entries(cursor.files)) {
    if (!isRecord(value)) continue;
    const byte_offset = numberFrom(value.byte_offset, 0);
    const mtime_ms = numberFrom(value.mtime_ms, 0);
    files[path] = { byte_offset, mtime_ms };
  }
  return { files };
}

function accumulateUsage(slice: string, buckets: Map<string, UsageReaderDelta>): void {
  for (const rawLine of slice.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const obj = parseJsonRecord(line);
    if (obj?.type !== "assistant") continue;
    const message = readRecord(obj, "message");
    const usage = message ? readRecord(message, "usage") : null;
    if (!usage) continue;
    const model = message ? readString(message, "model") : null;
    const bucket = getBucket(buckets, model);
    bucket.tokens_input += numberFrom(usage.input_tokens);
    bucket.tokens_output += numberFrom(usage.output_tokens);
    bucket.tokens_cache_read =
      (bucket.tokens_cache_read ?? 0) + numberFrom(usage.cache_read_input_tokens);
    bucket.tokens_cache_write =
      (bucket.tokens_cache_write ?? 0) + numberFrom(usage.cache_creation_input_tokens);
  }
}

function getBucket(buckets: Map<string, UsageReaderDelta>, model: string | null): UsageReaderDelta {
  const key = `anthropic\0${model ?? ""}`;
  const existing = buckets.get(key);
  if (existing) return existing;
  const now = new Date().toISOString();
  const created: UsageReaderDelta = {
    provider: "anthropic",
    model,
    tokens_input: 0,
    tokens_output: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    cost_usd: null,
    window_start: now,
    window_end: now,
  };
  buckets.set(key, created);
  return created;
}
