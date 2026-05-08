import type { Database } from 'bun:sqlite';
import type {
  BoundsAxis,
  CapCheckWarn,
  MaestroSessionRecord,
  MaestroTerminationReason,
  Services,
} from '@penumbra/core';
import { checkPressureCap } from '@penumbra/core';
import { formatBudgetWarning } from './warning-text.js';
import { buildProviderCaps } from './build-provider-caps.js';

interface BoundsSnapshot {
  wall_clock_ms: number;
  cost_cents: number;
  sub_dispatches: number;
  pct_consumed: number;
  axis_breakdown: Record<BoundsAxis, number>;
}

export interface CreateBoundsCallbacksOpts {
  db: Database;
  services?: Services;
  taskWriter: {
    fail(input: { task_id: string; lease_id: string; reason: string }): unknown;
  };
  sessions: {
    terminate(task_id: string, reason: MaestroTerminationReason): void;
  };
  injector: { inject: (chain_handoff_id: string, message: { role: 'user'; text: string }) => Promise<void> };
  bus: {
    publish(event: {
      task_id: string;
      at: number;
      kind: string;
      actor: string | null;
      payload: Record<string, unknown> | null;
    }): void;
  };
  chainCancel: (chain_handoff_id: string) => Promise<void>;
  now?: () => number;
}

interface TaskStatusRow {
  status: string;
}

interface OpenLeaseRow {
  id: string;
}

type AgentChatConfigLike = {
  agents: Array<{
    name: string;
    pricing_mode?: 'api' | 'subscription';
    subscription_provider?: string;
    subscription_model?: string;
  }>;
};

function ratio(consumed: number, budget: number): number {
  if (budget <= 0) return 1;
  return consumed / budget;
}

function computeSnapshot(session: MaestroSessionRecord, nowMs: number): BoundsSnapshot {
  const wall_clock_ms = nowMs - session.started_at;
  const wall_clock = Math.min(1, ratio(wall_clock_ms, session.wall_clock_budget_ms));
  const cost = ratio(session.cost_consumed_cents, session.cost_budget_cents);
  const sub_dispatches = ratio(session.sub_dispatches_consumed, session.sub_dispatch_budget);
  const pct_consumed = Math.max(wall_clock, cost, sub_dispatches);

  return {
    wall_clock_ms,
    cost_cents: session.cost_consumed_cents,
    sub_dispatches: session.sub_dispatches_consumed,
    pct_consumed,
    axis_breakdown: {
      wall_clock,
      cost,
      sub_dispatches,
      subscription_pressure: 0,
    },
  };
}

function insertTaskEvent(
  db: Database,
  bus: CreateBoundsCallbacksOpts['bus'],
  input: {
    task_id: string;
    at: number;
    kind: 'orchestrate_warning' | 'orchestrate_terminated';
    payload: Record<string, unknown>;
  },
): void {
  const payload_json = JSON.stringify(input.payload);
  db.query<unknown, [string, string, number, string, string]>(
    `INSERT INTO task_events (task_id, maestro_session_task_id, at, kind, actor, payload_json)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run(input.task_id, input.task_id, input.at, input.kind, payload_json);

  bus.publish({
    task_id: input.task_id,
    at: input.at,
    kind: input.kind as never,
    actor: null,
    payload: input.payload,
  });
}

function synthesizeFailedWithoutLease(
  db: Database,
  task_id: string,
  reason: string,
  nowMs: number,
): void {
  db.query<unknown, [string, number, string]>(
    `UPDATE tasks
     SET status = 'failed', failure_reason = ?, updated_at = ?
     WHERE id = ? AND status NOT IN ('done', 'done_pending_review', 'failed', 'cancelled')`,
  ).run(reason, nowMs, task_id);
}

function recordPressureCapTrip(opts: {
  db: Database;
  session: MaestroSessionRecord;
  outcome: Extract<ReturnType<typeof checkPressureCap>, { state: 'refuse' }>;
}): void {
  const ts = new Date().toISOString();
  opts.db.prepare(`
    INSERT INTO t0_events (event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, payload_json)
    VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'subscription-pressure-cap-trip', 'cli-subscription', ?, ?)
  `).run(
    crypto.randomUUID(),
    ts,
    ts,
    opts.outcome.provider,
    JSON.stringify({
      ...opts.outcome,
      subject: 'maestro',
      trigger: 'tracker_tick',
      agent_name: opts.session.agent_id,
      task_id: opts.session.task_id,
    }),
  );
}

function terminateSessionWithReason(opts: {
  db: Database;
  taskWriter: CreateBoundsCallbacksOpts['taskWriter'];
  sessions: CreateBoundsCallbacksOpts['sessions'];
  chainCancel: CreateBoundsCallbacksOpts['chainCancel'];
  bus: CreateBoundsCallbacksOpts['bus'];
  session: MaestroSessionRecord;
  reason: MaestroTerminationReason;
  nowMs: number;
}): void {
  const statusRow = opts.db
    .query<TaskStatusRow | null, [string]>(
      'SELECT status FROM tasks WHERE id = ?',
    )
    .get(opts.session.task_id);
  if (statusRow && (statusRow.status === 'done' || statusRow.status === 'done_pending_review')) {
    opts.sessions.terminate(opts.session.task_id, 'completed');
    return;
  }

  opts.sessions.terminate(opts.session.task_id, opts.reason);

  const leaseRow = opts.db
    .query<OpenLeaseRow | null, [string]>(
      `SELECT id
       FROM task_leases
       WHERE task_id = ? AND released_at IS NULL
       ORDER BY claimed_at DESC
       LIMIT 1`,
    )
    .get(opts.session.task_id);

  if (leaseRow) {
    try {
      opts.taskWriter.fail({
        task_id: opts.session.task_id,
        lease_id: leaseRow.id,
        reason: opts.reason,
      });
    } catch {
      synthesizeFailedWithoutLease(opts.db, opts.session.task_id, opts.reason, opts.nowMs);
    }
  } else {
    synthesizeFailedWithoutLease(opts.db, opts.session.task_id, opts.reason, opts.nowMs);
  }

  const snapshot = computeSnapshot(opts.session, opts.nowMs);
  insertTaskEvent(opts.db, opts.bus, {
    task_id: opts.session.task_id,
    at: opts.nowMs,
    kind: 'orchestrate_terminated',
    payload: {
      reason: opts.reason,
      consumed: {
        wall_clock_ms: snapshot.wall_clock_ms,
        cost_cents: snapshot.cost_cents,
        sub_dispatches: snapshot.sub_dispatches,
        pct_consumed: snapshot.pct_consumed,
        axis_breakdown: snapshot.axis_breakdown,
      },
    },
  });

  void opts.chainCancel(opts.session.chain_handoff_id).catch((error) => {
    console.error(`[bounds-callbacks] chain cancel failed for chain_handoff_id=${opts.session.chain_handoff_id}`, error);
  });
}

function evaluatePressureForSession(
  services: Services | undefined,
  session: MaestroSessionRecord,
): { kind: 'warn'; outcome: CapCheckWarn } | { kind: 'refuse'; outcome: Extract<ReturnType<typeof checkPressureCap>, { state: 'refuse' }>; reason: MaestroTerminationReason } | null {
  if (!services) return null;
  const cfg = (services as Services & { agentchatConfig?: AgentChatConfigLike }).agentchatConfig;
  const agent = cfg?.agents.find((candidate) => candidate.name === session.agent_id);
  if (!agent || agent.pricing_mode !== 'subscription') return null;
  const providerCaps = buildProviderCaps(services.providerQuotas);
  const agentForCheck = {
    name: agent.name,
    pricing_mode: agent.pricing_mode,
    subscription_provider: agent.subscription_provider,
    subscription_model: agent.subscription_model,
  };
  const outcome = checkPressureCap({
    cache: services.subscriptionPressureCache,
    agent: agentForCheck,
    providerCaps: providerCaps as unknown as Parameters<typeof checkPressureCap>[0]['providerCaps'],
  });
  if (outcome.state === 'warn') {
    return { kind: 'warn', outcome };
  }
  if (outcome.state !== 'refuse') return null;
  const reason = (outcome.reason === 'over_threshold'
    ? 'pressure_capped:over_threshold'
    : 'pressure_capped:stale_warm') as MaestroTerminationReason;
  return { kind: 'refuse', outcome, reason };
}

function formatPressureWarning(outcome: CapCheckWarn): string {
  return `Subscription pressure on ${outcome.provider} is at ${outcome.used_pct}% for the ${outcome.window_label} window (warn threshold ${outcome.warn_pct}%, refuse threshold ${outcome.refuse_pct}%). You may be hard-stopped soon if usage continues. Consider winding down the current task or routing the next dispatch to a different provider.`;
}

export function createBoundsCallbacks(opts: CreateBoundsCallbacksOpts): {
  onSoftWarn: (session: MaestroSessionRecord) => void;
  onPressureSoftWarn: (session: MaestroSessionRecord, outcome: CapCheckWarn) => void;
  onHardKill: (session: MaestroSessionRecord, axis: BoundsAxis) => void;
  evaluatePressure: (session: MaestroSessionRecord) => { kind: 'warn'; outcome: CapCheckWarn } | { kind: 'refuse'; axis: BoundsAxis } | null;
} {
  const now = opts.now ?? Date.now;
  const services = opts.services;

  return {
    evaluatePressure(session) {
      const result = evaluatePressureForSession(services, session);
      if (!result) return null;
      if (result.kind === 'warn') return { kind: 'warn', outcome: result.outcome };
      return { kind: 'refuse', axis: 'subscription_pressure' };
    },
    onSoftWarn(session): void {
      const nowMs = now();
      const snapshot = computeSnapshot(session, nowMs);
      const text = formatBudgetWarning(
        {
          wall_clock_ms: snapshot.wall_clock_ms,
          cost_cents: snapshot.cost_cents,
          sub_dispatches: snapshot.sub_dispatches,
          pct: snapshot.pct_consumed,
          axis_breakdown: snapshot.axis_breakdown,
        },
        {
          wall_clock_budget_ms: session.wall_clock_budget_ms,
          cost_budget_cents: session.cost_budget_cents,
          sub_dispatch_budget: session.sub_dispatch_budget,
        },
      );

      void opts.injector.inject(session.chain_handoff_id, { role: 'user', text }).catch((error) => {
        console.error(`[bounds-callbacks] soft warn inject failed for chain_handoff_id=${session.chain_handoff_id}`, error);
      });

      insertTaskEvent(opts.db, opts.bus, {
        task_id: session.task_id,
        at: nowMs,
        kind: 'orchestrate_warning',
        payload: {
          pct_consumed: snapshot.pct_consumed,
          axis_breakdown: snapshot.axis_breakdown,
          soft_warned_at: nowMs,
        },
      });
    },

    onPressureSoftWarn(session, outcome): void {
      const nowMs = now();
      const text = formatPressureWarning(outcome);

      void opts.injector.inject(session.chain_handoff_id, { role: 'user', text }).catch((error) => {
        console.error(`[bounds-callbacks] pressure soft warning failed for chain_handoff_id=${session.chain_handoff_id}`, error);
      });

      insertTaskEvent(opts.db, opts.bus, {
        task_id: session.task_id,
        at: nowMs,
        kind: 'orchestrate_warning',
        payload: {
          axis: 'subscription_pressure',
          provider: outcome.provider,
          window_label: outcome.window_label,
          used_pct: outcome.used_pct,
          warn_pct: outcome.warn_pct,
          refuse_pct: outcome.refuse_pct,
          soft_warned_at: nowMs,
        },
      });
    },

    onHardKill(session, axis): void {
      const nowMs = now();
      const pressure = evaluatePressureForSession(services, session);
      if (pressure?.kind === 'refuse') {
        recordPressureCapTrip({ db: opts.db, session, outcome: pressure.outcome });
        terminateSessionWithReason({
          db: opts.db,
          taskWriter: opts.taskWriter,
          sessions: opts.sessions,
          chainCancel: opts.chainCancel,
          bus: opts.bus,
          session,
          reason: pressure.reason,
          nowMs,
        });
        return;
      }

      const reason = `bounds_exceeded:${axis}` as MaestroTerminationReason;
      terminateSessionWithReason({
        db: opts.db,
        taskWriter: opts.taskWriter,
        sessions: opts.sessions,
        chainCancel: opts.chainCancel,
        bus: opts.bus,
        session,
        reason,
        nowMs,
      });
    },
  };
}
