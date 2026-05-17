import { verifyMemory, type Services } from '@penumbra/core';

export interface MemoryVerifyAutoFireResult {
  memories_in_prompt: number;
  events_written: number;
  events_skipped_idempotent: number;
  events_skipped_no_write: number;
}

export interface MemoryVerifyAutoFireInput {
  services: Services;
  handoffId: string;
  verdict: 'passed' | 'failed' | 'skipped' | 'review_debt';
  verdictSummary: string;
}

const DEFAULT_MEMORY_VERIFY_MAX_PER_TICK = 50;

function parseMemoryIdsFromInjectedEvent(metaJson: string | null): string[] {
  if (!metaJson) return [];
  try {
    const meta = JSON.parse(metaJson) as Record<string, unknown>;
    if (typeof meta.memory_id === 'string') return [meta.memory_id];
    if (Array.isArray(meta.memory_ids)) {
      return meta.memory_ids.filter((value): value is string => typeof value === 'string');
    }
  } catch {}
  return [];
}

function isAutoFireEnabled(): boolean {
  const v = process.env.PENUMBRA_MEMORY_VERIFY_AUTO_FIRE;
  if (v === undefined) return true;
  if (v === '0' || v === 'false') return false;
  if (v === '1' || v === 'true') return true;
  return true;
}

export function enqueueMemoryVerifyJob(input: MemoryVerifyAutoFireInput): MemoryVerifyAutoFireResult {
  if (!isAutoFireEnabled()) {
    return { memories_in_prompt: 0, events_written: 0, events_skipped_idempotent: 0, events_skipped_no_write: 0 };
  }

  const { services } = input;
  const handoff = services.db.query<{ to_agent: string }, [string]>(
    `SELECT to_agent FROM handoffs WHERE handoff_id = ?`,
  ).get(input.handoffId);
  if (!handoff) {
    return { memories_in_prompt: 0, events_written: 0, events_skipped_idempotent: 0, events_skipped_no_write: 0 };
  }

  const rows = services.db.query<{ meta_json: string | null }, [string]>(
    `SELECT meta_json FROM dispatch_events WHERE handoff_id = ? AND kind = 'memory_recall_injected' ORDER BY ts ASC, id ASC`,
  ).all(input.handoffId);

  const memoryIds = rows.flatMap((row) => parseMemoryIdsFromInjectedEvent(row.meta_json));
  const maxPerTick = resolveMemoryVerifyMaxPerTick();
  const memoryIdsToProcess = memoryIds.slice(0, maxPerTick);
  let eventsWritten = 0;
  let eventsSkippedIdempotent = 0;
  let eventsSkippedNoWrite = 0;
  const verifierActor = 'auto-lane-close';
  const claimedBy = handoff.to_agent;
  const reason = `lane closed ${input.verdict}: ${input.verdictSummary}`;

  for (const memoryId of memoryIdsToProcess) {
    const exists = services.db.query<{ one: number }, [string, string]>(
      `SELECT 1 AS one FROM t2_memory_verification_events WHERE memory_id = ? AND session_id = ? LIMIT 1`,
    ).get(memoryId, input.handoffId);
    if (exists) {
      eventsSkippedIdempotent++;
      continue;
    }
    const verified = verifyMemory(services.db, memoryId, {
      verifierActor,
      claimedBy,
      reason,
      sessionId: input.handoffId,
      uuid: services.uuid,
      now: services.clock,
    });
    if (verified?.written) {
      eventsWritten++;
    } else if (verified) {
      eventsSkippedIdempotent++;
    } else {
      eventsSkippedNoWrite++;
    }
  }

  services.log.info(
    {
      component: 'memory-verify-auto-fire',
      handoff_id: input.handoffId,
      memories_in_prompt: memoryIds.length,
      memories_processed: memoryIdsToProcess.length,
      max_per_tick: maxPerTick,
      events_written: eventsWritten,
      events_skipped_idempotent: eventsSkippedIdempotent,
      events_skipped_no_write: eventsSkippedNoWrite,
      msg: 'memory-verify: auto-fired on lane close',
    },
    'memory-verify: auto-fired on lane close',
  );

  return {
    memories_in_prompt: memoryIds.length,
    events_written: eventsWritten,
    events_skipped_idempotent: eventsSkippedIdempotent,
    events_skipped_no_write: eventsSkippedNoWrite,
  };
}

function resolveMemoryVerifyMaxPerTick(): number {
  const raw = process.env.PENUMBRA_MEMORY_VERIFY_MAX_PER_TICK;
  if (raw === undefined) return DEFAULT_MEMORY_VERIFY_MAX_PER_TICK;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MEMORY_VERIFY_MAX_PER_TICK;
  return Math.min(parsed, 500);
}

export interface HandoffSweeperOpts {
  services: Services;
  pendingTtlMs?: number;
  dispatchedTtlMs?: number;
}

export function createHandoffSweeperWorker(opts: HandoffSweeperOpts) {
  return {
    async tick(): Promise<void> {
      try {
        const pendingTtlMs = opts.pendingTtlMs ?? (process.env.PENUMBRA_HANDOFF_PENDING_TTL_MS ? parseInt(process.env.PENUMBRA_HANDOFF_PENDING_TTL_MS, 10) : 3600000);
        const dispatchedTtlMs = opts.dispatchedTtlMs ?? (process.env.PENUMBRA_HANDOFF_DISPATCHED_TTL_MS ? parseInt(process.env.PENUMBRA_HANDOFF_DISPATCHED_TTL_MS, 10) : 1800000);

        const now = new Date(opts.services.clock());
        const nowIso = now.toISOString();
        const pendingThreshold = new Date(now.getTime() - pendingTtlMs).toISOString();
        const dispatchedThreshold = new Date(now.getTime() - dispatchedTtlMs).toISOString();

        const updateHandoffs = opts.services.db.transaction(() => {
          const stmt = opts.services.db.query(`
            UPDATE handoffs
            SET 
              status = 'expired',
              resolved_at = ?1,
              resolution_reason = CASE 
                WHEN status = 'pending' THEN ?2
                WHEN status = 'dispatched' THEN ?3
              END
            WHERE (status = 'pending' AND ts < ?4)
               OR (status = 'dispatched' AND ts < ?5)
          `);

          const reasonPending = `expired by sweeper after ${pendingTtlMs}ms in pending`;
          const reasonDispatched = `expired by sweeper after ${dispatchedTtlMs}ms in dispatched`;

          return stmt.run(nowIso, reasonPending, reasonDispatched, pendingThreshold, dispatchedThreshold).changes;
        });

        const count = updateHandoffs();

        if (count > 0) {
          opts.services.log.info({ count }, 'handoff sweeper: marked stuck handoffs as expired');
        }
      } catch (err) {
        opts.services.log.error({ err }, 'handoff sweeper: failed to sweep handoffs');
      }
    },
  };
}
