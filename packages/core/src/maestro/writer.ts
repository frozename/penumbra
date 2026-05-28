import type { Database } from "bun:sqlite";
import {
  MaestroSessionRecord,
  type MaestroSessionRecord as MaestroSessionRecordType,
  type MaestroTerminationReason,
} from "./schema.js";

export interface MaestroSessionWriterOpts {
  db: Database;
  now?: () => number;
}

export interface StartMaestroSessionParams {
  task_id: string;
  chain_handoff_id?: string | null;
  agent_id: string;
  wall_clock_budget_ms: number;
  cost_budget_cents: number;
  sub_dispatch_budget: number;
}

export class MaestroSessionExists extends Error {
  constructor(public readonly task_id: string) {
    super(`maestro session already exists for task ${task_id}`);
    this.name = "MaestroSessionExists";
  }
}

export class MaestroSessionAlreadyDispatched extends Error {
  constructor(public readonly task_id: string) {
    super(`maestro session already dispatched for task ${task_id}`);
    this.name = "MaestroSessionAlreadyDispatched";
  }
}

type MaestroSessionRow = {
  task_id: string;
  chain_handoff_id: string | null;
  agent_id: string;
  started_at: number;
  wall_clock_budget_ms: number;
  cost_budget_cents: number;
  sub_dispatch_budget: number;
  cost_consumed_cents: number;
  sub_dispatches_consumed: number;
  soft_warned_at: number | null;
  terminated_at: number | null;
  termination_reason: string | null;
};

export class MaestroSessionWriter {
  private readonly now: () => number;

  constructor(private readonly opts: MaestroSessionWriterOpts) {
    this.now = opts.now ?? Date.now;
  }

  start(params: StartMaestroSessionParams): MaestroSessionRecordType {
    return this.opts.db.transaction(() => {
      const existing = this.opts.db
        .query<
          { task_id: string },
          [string]
        >("SELECT task_id FROM maestro_sessions WHERE task_id = ?")
        .get(params.task_id);
      if (existing) {
        throw new MaestroSessionExists(params.task_id);
      }

      const started_at = this.now();
      this.opts.db
        .query<unknown, [string, string | null, string, number, number, number, number]>(
          `INSERT INTO maestro_sessions (
            task_id, chain_handoff_id, agent_id, started_at,
            wall_clock_budget_ms, cost_budget_cents, sub_dispatch_budget
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          params.task_id,
          params.chain_handoff_id ?? null,
          params.agent_id,
          started_at,
          params.wall_clock_budget_ms,
          params.cost_budget_cents,
          params.sub_dispatch_budget,
        );

      const row = this.getRequiredRow(params.task_id);
      return row;
    })();
  }

  markDispatched(task_id: string, chain_handoff_id: string): MaestroSessionRecordType {
    return this.opts.db.transaction(() => {
      const current = this.opts.db
        .query<
          { chain_handoff_id: string | null } | null,
          [string]
        >("SELECT chain_handoff_id FROM maestro_sessions WHERE task_id = ? LIMIT 1")
        .get(task_id);
      if (!current) {
        throw new Error(`maestro session missing for task ${task_id}`);
      }
      if (current.chain_handoff_id !== null) {
        throw new MaestroSessionAlreadyDispatched(task_id);
      }

      this.opts.db
        .query<
          unknown,
          [string, string]
        >("UPDATE maestro_sessions SET chain_handoff_id = ? WHERE task_id = ? AND chain_handoff_id IS NULL")
        .run(chain_handoff_id, task_id);

      return this.getRequiredRow(task_id);
    })();
  }

  get(task_id: string): MaestroSessionRecordType | null {
    const row = this.opts.db
      .query<MaestroSessionRow | null, [string]>("SELECT * FROM maestro_sessions WHERE task_id = ?")
      .get(task_id);
    return row ? MaestroSessionRecord.parse(row) : null;
  }

  getByChainHandoff(chain_handoff_id: string): MaestroSessionRecordType | null {
    const row = this.opts.db
      .query<
        MaestroSessionRow | null,
        [string]
      >("SELECT * FROM maestro_sessions WHERE chain_handoff_id = ?")
      .get(chain_handoff_id);
    return row ? MaestroSessionRecord.parse(row) : null;
  }

  listLive(): MaestroSessionRecordType[] {
    const rows = this.opts.db
      .query<
        MaestroSessionRow,
        []
      >("SELECT * FROM maestro_sessions WHERE terminated_at IS NULL ORDER BY started_at ASC")
      .all();
    return rows.map((row) => MaestroSessionRecord.parse(row));
  }

  bumpCostConsumed(task_id: string, cost_consumed_cents: number): void {
    this.opts.db
      .query<
        unknown,
        [number, string]
      >("UPDATE maestro_sessions SET cost_consumed_cents = ? WHERE task_id = ? AND terminated_at IS NULL")
      .run(cost_consumed_cents, task_id);
  }

  incrementSubDispatch(task_id: string): { new_count: number; budget: number } {
    return this.opts.db.transaction(() => {
      const result = this.opts.db
        .query<
          unknown,
          [string]
        >("UPDATE maestro_sessions SET sub_dispatches_consumed = sub_dispatches_consumed + 1 WHERE task_id = ? AND terminated_at IS NULL")
        .run(task_id);
      if (result.changes === 0) {
        return { new_count: 0, budget: 0 };
      }

      const row = this.getRequiredRow(task_id);
      return {
        new_count: row.sub_dispatches_consumed,
        budget: row.sub_dispatch_budget,
      };
    })();
  }

  markSoftWarned(task_id: string): void {
    this.opts.db
      .query<
        unknown,
        [number, string]
      >("UPDATE maestro_sessions SET soft_warned_at = ? WHERE task_id = ? AND soft_warned_at IS NULL")
      .run(this.now(), task_id);
  }

  terminate(task_id: string, reason: MaestroTerminationReason): void {
    this.opts.db
      .query<
        unknown,
        [number, string, string]
      >("UPDATE maestro_sessions SET terminated_at = ?, termination_reason = ? WHERE task_id = ? AND terminated_at IS NULL")
      .run(this.now(), reason, task_id);
  }

  private getRequiredRow(task_id: string): MaestroSessionRecordType {
    const row = this.opts.db
      .query<MaestroSessionRow | null, [string]>("SELECT * FROM maestro_sessions WHERE task_id = ?")
      .get(task_id);
    if (!row) {
      throw new Error(`maestro session missing for task ${task_id}`);
    }
    return MaestroSessionRecord.parse(row);
  }
}
