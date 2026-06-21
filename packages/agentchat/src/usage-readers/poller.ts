import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RateLimitDelta, UsageReader, UsageReaderResult } from "./index.js";

export interface PollerOptions {
  readers: UsageReader[];
  intervalMs?: number;
  cursorPath: string;
  emit: (event: any) => Promise<{ event_id: string }>;
  log: { info: (m: any, ...rest: any[]) => void; error: (m: any, ...rest: any[]) => void };
  /**
   * Per-tick gate for `machineGlobal` readers. Returns true when THIS worker
   * holds the machine usage-poll lock and should run the host-shared readers.
   * Called once per tick (so leadership can fail over). When omitted, every
   * reader runs (single-process / test default).
   */
  acquireMachineLock?: () => boolean;
  /**
   * Optional: returns the workerId currently holding the machine poll lock, used
   * only for operator-friendly logging on a holder→non-holder transition.
   */
  describeLockHolder?: () => string | null;
}

export interface PollerHandle {
  stop: () => void;
  runOnce: () => Promise<void>;
  /** Total number of cursor-file persists since start; coalesced to ≤1 per tick. */
  persistCount: () => number;
}

type CursorMap = Record<string, unknown>;

export function usageCursorTempPath(cursorPath: string, pid = process.pid): string {
  return `${cursorPath}.${pid}.tmp`;
}

export function resolveUsageCursorPath(opts: {
  storageRoot: string;
  workerId: string;
  env: Record<string, string | undefined>;
}): string {
  if (opts.env.PENUMBRA_PER_WORKER_USAGE_CURSOR === "0") {
    return join(opts.storageRoot, "local-state-cursors.json");
  }
  const safeWorkerId = opts.workerId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(opts.storageRoot, `local-state-cursors.${safeWorkerId}.json`);
}

export function startUsagePoller(opts: PollerOptions): PollerHandle {
  const intervalMs = opts.intervalMs ?? 60_000;
  // Reassigned on machine-lock takeover so a new holder resumes from the shared
  // cursor file instead of re-reading the source from its own stale snapshot.
  let cursors = loadCursors(opts.cursorPath, opts.log);
  const lastEmittedIds = new Set<string>();
  const lastEmittedOrder: string[] = [];
  let stopped = false;
  let heldLock: boolean | undefined;
  let persistCount = 0;

  const persist = async (): Promise<void> => {
    const dir = dirname(opts.cursorPath);
    mkdirSync(dir, { recursive: true });
    const tmp = usageCursorTempPath(opts.cursorPath);
    await writeFile(tmp, `${JSON.stringify(cursors)}\n`);
    await rename(tmp, opts.cursorPath);
    persistCount++;
  };

  const runReader = async (reader: UsageReader): Promise<boolean> => {
    const prev = Object.prototype.hasOwnProperty.call(cursors, reader.id)
      ? cursors[reader.id]
      : null;
    const result = await reader.read(prev);
    const ok = await emitResult(
      reader.id,
      result,
      opts.emit,
      opts.log,
      lastEmittedIds,
      lastEmittedOrder,
    );
    if (ok) {
      cursors[reader.id] = result.cursor;
      return true;
    }
    return false;
  };

  const runOnce = async (): Promise<void> => {
    const holdsLock = opts.acquireMachineLock ? opts.acquireMachineLock() : true;
    if (opts.acquireMachineLock && holdsLock !== heldLock) {
      const wasHolder = heldLock === true;
      heldLock = holdsLock;
      if (holdsLock) {
        if (!wasHolder) {
          // Took over: reload cursors so we resume where the previous holder
          // left off (shared cursor file), avoiding a re-read burst.
          cursors = loadCursors(opts.cursorPath, opts.log);
        }
        opts.log.info(
          { holdsLock },
          "usage-poller: holding machine poll lock; running machine-global readers",
        );
      } else {
        opts.log.info(
          { holdsLock, holder: opts.describeLockHolder?.() ?? null },
          "usage-poller: another worker holds the machine poll lock; skipping machine-global readers",
        );
      }
    }
    let dirty = false;
    for (const reader of opts.readers) {
      if (reader.machineGlobal && !holdsLock) continue;
      try {
        if (await runReader(reader)) dirty = true;
      } catch (err) {
        opts.log.error({ err: String(err), reader: reader.id }, "usage-poller: reader failed");
      }
    }
    if (dirty) {
      try {
        await persist();
      } catch (err) {
        opts.log.error({ err: String(err) }, "usage-poller: cursor persist failed");
      }
    }
  };

  const timer = setInterval(() => {
    if (stopped) return;
    runOnce().catch((err) => opts.log.error({ err: String(err) }, "usage-poller: tick failed"));
  }, intervalMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    runOnce,
    persistCount: () => persistCount,
  };
}

function loadCursors(cursorPath: string, log: PollerOptions["log"]): CursorMap {
  if (!existsSync(cursorPath)) return {};
  try {
    const raw = readFileSync(cursorPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CursorMap;
    }
  } catch (err) {
    log.error(
      { err: String(err), path: cursorPath },
      "usage-poller: cursor file corrupt; recreating",
    );
  }
  return {};
}

async function emitResult(
  readerId: string,
  result: UsageReaderResult,
  emit: PollerOptions["emit"],
  log: PollerOptions["log"],
  lastEmittedIds: Set<string>,
  lastEmittedOrder: string[],
): Promise<boolean> {
  let ok = true;
  for (const delta of result.usage_deltas) {
    const event = buildUsageEvent(readerId, delta);
    if (lastEmittedIds.has(event.event_id)) {
      continue;
    }
    try {
      const ack = await emit(event);
      rememberEmittedId(ack.event_id, lastEmittedIds, lastEmittedOrder);
    } catch (err) {
      ok = false;
      log.error(
        { err: String(err), readerId, event_type: "usage-update" },
        "usage-poller: emit failed",
      );
    }
  }

  for (const snapshot of result.rate_limit_snapshots) {
    const event = buildRateLimitEvent(readerId, snapshot);
    if (lastEmittedIds.has(event.event_id)) {
      continue;
    }
    try {
      const ack = await emit(event);
      rememberEmittedId(ack.event_id, lastEmittedIds, lastEmittedOrder);
    } catch (err) {
      ok = false;
      log.error(
        { err: String(err), readerId, event_type: "rate-limit-snapshot" },
        "usage-poller: emit failed",
      );
    }
  }

  return ok;
}

function rememberEmittedId(
  eventId: string,
  lastEmittedIds: Set<string>,
  lastEmittedOrder: string[],
): void {
  if (lastEmittedIds.has(eventId)) return;
  lastEmittedIds.add(eventId);
  lastEmittedOrder.push(eventId);
  if (lastEmittedOrder.length <= 256) return;
  const removed = lastEmittedOrder.shift();
  if (removed !== undefined) {
    lastEmittedIds.delete(removed);
  }
}

function buildBaseEvent(
  readerId: string,
  eventType: string,
  provider: string,
  model: string | null,
): any {
  return {
    ts: new Date().toISOString(),
    source: "agentchat",
    source_detail: `usage-poller-${readerId}`,
    user_id: "local-user",
    machine_id: "local",
    session_id: null,
    event_type: eventType,
    lane: "cli-subscription",
    provider,
    model,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: {},
    payload_summary: "",
  };
}

function buildUsageEvent(readerId: string, delta: UsageReaderResult["usage_deltas"][number]): any {
  const used = Number(delta.tokens_input ?? 0) + Number(delta.tokens_output ?? 0);
  const event = buildBaseEvent(readerId, "usage-update", delta.provider, delta.model);
  const stableId = stableUsageEventId(readerId, delta);
  event.event_id = stableId;
  event.request_id = stableId;
  event.tokens_in = delta.tokens_input;
  event.tokens_out = delta.tokens_output;
  event.cost_usd = delta.cost_usd;
  event.payload_json = {
    handoff_id: delta.handoff_id ?? null,
    used,
    tokens_input: delta.tokens_input,
    tokens_output: delta.tokens_output,
    tokens_cache_read: delta.tokens_cache_read ?? 0,
    tokens_cache_write: delta.tokens_cache_write ?? 0,
    window_start: delta.window_start,
    window_end: delta.window_end,
    source_kind: `local-state-${readerId}`,
  };
  event.payload_summary = `${delta.provider}/${delta.model ?? "?"}: ${used} tokens`.slice(0, 240);
  return event;
}

function stableUsageEventId(
  readerId: string,
  delta: UsageReaderResult["usage_deltas"][number],
): string {
  const key = JSON.stringify({
    readerId,
    provider: delta.provider,
    model: delta.model ?? null,
    handoff_id: delta.handoff_id ?? null,
    window_start: delta.window_start,
    window_end: delta.window_end,
  });
  return `usage-poller-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

function buildRateLimitEvent(readerId: string, snapshot: RateLimitDelta): any {
  const event = buildBaseEvent(
    readerId,
    "rate-limit-snapshot",
    snapshot.provider,
    snapshot.model ?? null,
  );
  event.payload_json = {
    window_label: snapshot.window_label,
    model: snapshot.model ?? null,
    used_pct: snapshot.used_pct,
    window_minutes: snapshot.window_minutes,
    resets_at: snapshot.resets_at,
    extra: snapshot.extra ?? null,
    source_kind: `local-state-${readerId}`,
  };
  event.payload_summary =
    `${snapshot.provider}/${snapshot.window_label}: ${snapshot.used_pct}%`.slice(0, 240);
  return event;
}
