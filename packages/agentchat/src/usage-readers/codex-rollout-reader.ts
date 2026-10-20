import { pressureSnapshotKey } from "@penumbra/core";
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RateLimitDelta, UsageReader, UsageReaderDelta, UsageReaderResult } from "./index.js";

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
interface RateLimitObservation {
  rateLimits: Record<string, unknown>;
  timestamp: number | null;
}

interface LatestRateLimitSnapshot {
  snapshot: RateLimitDelta;
  observedAt: number;
}

interface CodexRolloutCursor {
  groups?: Record<string, number>;
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
    const groups = { ...cursor.groups };
    const newCursor: CodexRolloutCursor = { files: { ...cursor.files }, groups };

    const files = this.listRolloutFiles();
    const latestByGroup = new Map<string, LatestRateLimitSnapshot>();
    const allUsageDeltas: UsageReaderDelta[] = [];
    const cutoff = this.now() - this.lookbackHours * 60 * 60 * 1000;
    const seenInWindow = new Set<string>();

    for (const filePath of files) {
      this.readRolloutFile(
        filePath,
        newCursor,
        cutoff,
        seenInWindow,
        latestByGroup,
        allUsageDeltas,
      );
    }

    newCursor.files = Object.fromEntries(
      Object.entries(newCursor.files).filter(([p]) => seenInWindow.has(p)),
    );

    const snapshots: RateLimitDelta[] = [];
    for (const [key, { snapshot, observedAt }] of latestByGroup) {
      const highWater = groups[key];
      if (highWater !== undefined && observedAt < highWater) continue;
      snapshots.push(snapshot);
      groups[key] = observedAt;
    }

    return {
      cursor: newCursor,
      usage_deltas: allUsageDeltas,
      rate_limit_snapshots: snapshots,
    };
  }

  private readRolloutFile(
    filePath: string,
    cursor: CodexRolloutCursor,
    cutoff: number,
    seenInWindow: Set<string>,
    latestByGroup: Map<string, LatestRateLimitSnapshot>,
    allUsageDeltas: UsageReaderDelta[],
  ): void {
    const fileCursor = cursor.files[filePath];
    const { mtimeMs: mtime_ms, size } = fs.statSync(filePath);
    if (mtime_ms < cutoff) return;
    seenInWindow.add(filePath);
    const offset = fileCursor?.byte_offset ?? 0;
    if (offset >= size) return;

    const scan = scanRolloutSlice(readTail(filePath, offset, size - offset));
    const modelProvider = fileCursor?.model_provider ?? scan.modelProvider;
    for (const observation of scan.rateLimitObservations) {
      const observedAt = Math.min(observation.timestamp ?? mtime_ms, this.now());
      for (const snapshot of this.buildRateLimitSnapshots(observation.rateLimits, modelProvider)) {
        const key = pressureSnapshotKey({ ...snapshot, model: snapshot.model ?? null });
        const previous = latestByGroup.get(key);
        if (!previous || observedAt >= previous.observedAt) {
          latestByGroup.set(key, { snapshot, observedAt });
        }
      }
    }
    const provider = modelProvider ?? this.canonicalizeProvider(undefined);
    for (const entry of scan.rawUsage) {
      allUsageDeltas.push({
        provider,
        model: entry.model,
        tokens_input: entry.tokens_input,
        tokens_output: entry.tokens_output,
        tokens_cache_read: entry.tokens_cache_read,
        cost_usd: null,
        window_start: entry.timestamp,
        window_end: entry.timestamp,
      });
    }
    cursor.files[filePath] = {
      byte_offset: size,
      mtime_ms,
      ...(modelProvider ? { model_provider: modelProvider } : {}),
    };
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
    return out.sort();
  }

  private canonicalizeProvider(limit_id: string | undefined): string {
    if (!limit_id || limit_id === "codex") return "openai";
    return limit_id;
  }

  private buildRateLimitSnapshots(
    rateLimits: Record<string, unknown>,
    modelProvider: string | undefined,
  ): RateLimitDelta[] {
    const snapshots: RateLimitDelta[] = [];
    const limitId = readString(rateLimits, "limit_id") ?? undefined;
    const provider = modelProvider?.length ? modelProvider : this.canonicalizeProvider(limitId);
    for (const key of ["primary", "secondary"] as const) {
      const raw = rateLimits[key];
      // Present-but-null means upstream retired the window; an absent key keeps
      // the old skip semantics so payload shapes that never had the window do
      // not start emitting tombstones.
      if (raw === undefined) continue;
      if (raw === null) {
        snapshots.push({
          provider,
          window_label: key,
          used_pct: 0,
          retired: true,
          extra: {
            plan_type: readString(rateLimits, "plan_type"),
            limit_id: limitId,
          },
        });
        continue;
      }
      const windowState = readRecord(rateLimits, key);
      if (!windowState) continue;
      snapshots.push({
        provider,
        window_label: key,
        used_pct: numberFrom(windowState.used_percent),
        window_minutes: readNumber(windowState, "window_minutes") ?? undefined,
        resets_at: readNumber(windowState, "resets_at") ?? undefined,
        extra: {
          plan_type: readString(rateLimits, "plan_type"),
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
  return { files, groups: normalizeGroups(cursor.groups) };
}

function normalizeGroups(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1]),
    ),
  );
}

interface RawUsageEntry {
  timestamp: string;
  model: string | null;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
}

interface RolloutScanResult {
  rateLimitObservations: RateLimitObservation[];
  modelProvider: string | undefined;
  rawUsage: RawUsageEntry[];
}

type RolloutScanState = {
  rateLimitObservations: RateLimitObservation[];
  modelProvider: string | undefined;
  currentModel: string | null;
  rawUsage: RawUsageEntry[];
};

function scanRolloutSlice(slice: string): RolloutScanResult {
  const state: RolloutScanState = {
    rateLimitObservations: [],
    modelProvider: undefined,
    currentModel: null,
    rawUsage: [],
  };
  for (const rawLine of slice.split("\n")) {
    scanRolloutLine(rawLine, state);
  }
  return state;
}

function scanRolloutLine(rawLine: string, state: RolloutScanState): void {
  const line = rawLine.trim();
  if (!line) return;
  const obj = parseJsonRecord(line);
  if (!obj) return;
  const payload = readRecord(obj, "payload");
  if (!payload) return;
  state.modelProvider ??= normalizeModelProvider(readString(payload, "model_provider"));
  const sessionModel = readString(payload, "model");
  if (sessionModel) state.currentModel = sessionModel;
  const rateLimits = readTokenCountRateLimits(obj, payload);
  if (rateLimits) {
    const timestamp = Date.parse(readString(obj, "timestamp") ?? "");
    state.rateLimitObservations.push({
      rateLimits,
      timestamp: Number.isFinite(timestamp) ? timestamp : null,
    });
  }
  const lastTokenUsage = readLastTokenUsage(obj, payload);
  if (lastTokenUsage) {
    state.rawUsage.push(toRawUsageEntry(lastTokenUsage, obj, state.currentModel));
  }
}

function toRawUsageEntry(
  usage: Record<string, unknown>,
  obj: Record<string, unknown>,
  model: string | null,
): RawUsageEntry {
  const input = numberFrom(usage.input_tokens);
  const cached = numberFrom(usage.cached_input_tokens);
  return {
    timestamp: readString(obj, "timestamp") ?? new Date().toISOString(),
    model,
    tokens_input: Math.max(0, input - cached),
    tokens_output: numberFrom(usage.output_tokens),
    tokens_cache_read: cached,
  };
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

function readLastTokenUsage(
  obj: Record<string, unknown>,
  payload: Record<string, unknown>,
): { input_tokens: unknown; cached_input_tokens: unknown; output_tokens: unknown } | null {
  if (obj.type !== "event_msg" || payload.type !== "token_count") return null;
  const info = readRecord(payload, "info");
  if (!info) return null;
  const last = readRecord(info, "last_token_usage");
  if (!last) return null;
  return {
    input_tokens: last.input_tokens,
    cached_input_tokens: last.cached_input_tokens,
    output_tokens: last.output_tokens,
  };
}
