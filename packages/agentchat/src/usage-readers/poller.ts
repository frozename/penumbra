import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RateLimitDelta, UsageReader, UsageReaderResult } from './index.js';

export interface PollerOptions {
  readers: UsageReader[];
  intervalMs?: number;
  cursorPath: string;
  emit: (event: any) => Promise<{ event_id: string }>;
  log: { info: (m: any, ...rest: any[]) => void; error: (m: any, ...rest: any[]) => void };
}

export interface PollerHandle {
  stop: () => void;
  runOnce: () => Promise<void>;
}

type CursorMap = Record<string, unknown>;

export function startUsagePoller(opts: PollerOptions): PollerHandle {
  const intervalMs = opts.intervalMs ?? 60_000;
  const cursors = loadCursors(opts.cursorPath, opts.log);
  let stopped = false;

  const persist = () => {
    const dir = dirname(opts.cursorPath);
    mkdirSync(dir, { recursive: true });
    const tmp = `${opts.cursorPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cursors)}\n`);
    renameSync(tmp, opts.cursorPath);
  };

  const runReader = async (reader: UsageReader): Promise<void> => {
    const prev = Object.prototype.hasOwnProperty.call(cursors, reader.id) ? cursors[reader.id] : null;
    const result = await reader.read(prev);
    await emitResult(reader.id, result, opts.emit, opts.log);
    cursors[reader.id] = result.cursor;
    persist();
  };

  const runOnce = async (): Promise<void> => {
    for (const reader of opts.readers) {
      try {
        await runReader(reader);
      } catch (err) {
        opts.log.error({ err: String(err), reader: reader.id }, 'usage-poller: reader failed');
      }
    }
  };

  const timer = setInterval(() => {
    if (stopped) return;
    runOnce().catch(err => opts.log.error({ err: String(err) }, 'usage-poller: tick failed'));
  }, intervalMs);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    runOnce,
  };
}

function loadCursors(cursorPath: string, log: PollerOptions['log']): CursorMap {
  if (!existsSync(cursorPath)) return {};
  try {
    const raw = readFileSync(cursorPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as CursorMap;
    }
  } catch (err) {
    log.error({ err: String(err), path: cursorPath }, 'usage-poller: cursor file corrupt; recreating');
  }
  return {};
}

async function emitResult(
  readerId: string,
  result: UsageReaderResult,
  emit: PollerOptions['emit'],
  log: PollerOptions['log'],
): Promise<void> {
  for (const delta of result.usage_deltas) {
    const event = buildUsageEvent(readerId, delta);
    try {
      await emit(event);
    } catch (err) {
      log.error({ err: String(err), readerId, event_type: 'usage-update' }, 'usage-poller: emit failed');
    }
  }

  for (const snapshot of result.rate_limit_snapshots) {
    const event = buildRateLimitEvent(readerId, snapshot);
    try {
      await emit(event);
    } catch (err) {
      log.error({ err: String(err), readerId, event_type: 'rate-limit-snapshot' }, 'usage-poller: emit failed');
    }
  }
}

function buildBaseEvent(readerId: string, eventType: string, provider: string, model: string | null): any {
  return {
    ts: new Date().toISOString(),
    source: 'agentchat',
    source_detail: `usage-poller-${readerId}`,
    user_id: 'local-user',
    machine_id: 'local',
    session_id: null,
    event_type: eventType,
    lane: 'cli-subscription',
    provider,
    model,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: {},
    payload_summary: '',
  };
}

function buildUsageEvent(readerId: string, delta: UsageReaderResult['usage_deltas'][number]): any {
  const used = Number(delta.tokens_input ?? 0) + Number(delta.tokens_output ?? 0);
  const event = buildBaseEvent(readerId, 'usage-update', delta.provider, delta.model);
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
  event.payload_summary = `${delta.provider}/${delta.model ?? '?'}: ${used} tokens`.slice(0, 240);
  return event;
}

function buildRateLimitEvent(readerId: string, snapshot: RateLimitDelta): any {
  const event = buildBaseEvent(readerId, 'rate-limit-snapshot', snapshot.provider, null);
  event.payload_json = {
    window_label: snapshot.window_label,
    used_pct: snapshot.used_pct,
    window_minutes: snapshot.window_minutes,
    resets_at: snapshot.resets_at,
    extra: snapshot.extra ?? null,
    source_kind: `local-state-${readerId}`,
  };
  event.payload_summary = `${snapshot.provider}/${snapshot.window_label}: ${snapshot.used_pct}%`.slice(0, 240);
  return event;
}
