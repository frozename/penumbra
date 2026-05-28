import type { Database } from "bun:sqlite";
import {
  PlanRecordSchema,
  PlanStatusSchema,
  PlanTaskRecordSchema,
  PlanTaskStatusSchema,
  type PlanRecord,
  type PlanStatus,
  type PlanTaskRecord,
  type PlanTaskStatus,
} from "./schema.js";

export class PlanAlreadyRegistered extends Error {
  readonly plan_id: string;
  constructor(plan_id: string) {
    super(`plan ${plan_id} already registered`);
    this.name = "PlanAlreadyRegistered";
    this.plan_id = plan_id;
  }
}

export class PlanNotFound extends Error {
  readonly plan_id: string;
  constructor(plan_id: string) {
    super(`plan ${plan_id} not found`);
    this.name = "PlanNotFound";
    this.plan_id = plan_id;
  }
}

export class PlanTaskNotFound extends Error {
  readonly plan_id: string;
  readonly task_meta_id: string;
  constructor(plan_id: string, task_meta_id: string) {
    super(`plan task ${plan_id}/${task_meta_id} not found`);
    this.name = "PlanTaskNotFound";
    this.plan_id = plan_id;
    this.task_meta_id = task_meta_id;
  }
}

export interface RegisterPlanInput {
  plan_id: string;
  file_path: string;
  home_project: string;
  tasks: Array<{ task_meta_id: string; project_id: string }>;
}

type PlanRow = {
  plan_id: string;
  file_path: string;
  home_project: string;
  registered_at: number;
  status: string;
};

type PlanTaskRow = {
  plan_id: string;
  task_meta_id: string;
  project_id: string;
  task_id_in_board: string | null;
  status: string;
  last_event_ts: number | null;
};

export class PlanWriter {
  private readonly nowFn: () => number;

  constructor(
    private readonly db: Database,
    now: () => number = () => Date.now(),
  ) {
    this.nowFn = now;
  }

  register(input: RegisterPlanInput): PlanRecord {
    return this.db.transaction(() => {
      const existing = this.db
        .query<{ plan_id: string }, [string]>("SELECT plan_id FROM plans WHERE plan_id = ?")
        .get(input.plan_id);
      if (existing) {
        throw new PlanAlreadyRegistered(input.plan_id);
      }

      const registered_at = this.nowFn();
      this.db
        .query<unknown, [string, string, string, number, string]>(
          `INSERT INTO plans (plan_id, file_path, home_project, registered_at, status)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.plan_id, input.file_path, input.home_project, registered_at, "running");

      const insertTask = this.db.query<unknown, [string, string, string, string]>(
        `INSERT INTO plan_tasks (plan_id, task_meta_id, project_id, status)
         VALUES (?, ?, ?, ?)`,
      );
      for (const t of input.tasks) {
        insertTask.run(input.plan_id, t.task_meta_id, t.project_id, "pending");
      }

      return this.requirePlan(input.plan_id);
    })();
  }

  getPlan(plan_id: string): PlanRecord | undefined {
    const row = this.db
      .query<PlanRow | null, [string]>("SELECT * FROM plans WHERE plan_id = ?")
      .get(plan_id);
    return row ? PlanRecordSchema.parse(row) : undefined;
  }

  listPlans(opts?: { status?: PlanStatus }): PlanRecord[] {
    const rows = opts?.status
      ? this.db
          .query<
            PlanRow,
            [string]
          >("SELECT * FROM plans WHERE status = ? ORDER BY registered_at DESC")
          .all(opts.status)
      : this.db.query<PlanRow, []>("SELECT * FROM plans ORDER BY registered_at DESC").all();
    return rows.map((r) => PlanRecordSchema.parse(r));
  }

  getTasks(plan_id: string): PlanTaskRecord[] {
    const rows = this.db
      .query<
        PlanTaskRow,
        [string]
      >("SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY task_meta_id ASC")
      .all(plan_id);
    return rows.map((r) => PlanTaskRecordSchema.parse(r));
  }

  bindTaskToBoard(plan_id: string, task_meta_id: string, task_id_in_board: string): void {
    this.db.transaction(() => {
      const row = this.db
        .query<
          { task_id_in_board: string | null },
          [string, string]
        >("SELECT task_id_in_board FROM plan_tasks WHERE plan_id = ? AND task_meta_id = ?")
        .get(plan_id, task_meta_id);
      if (!row) {
        throw new PlanTaskNotFound(plan_id, task_meta_id);
      }
      if (row.task_id_in_board !== null) {
        return;
      }
      this.db
        .query<unknown, [string, string, string]>(
          `UPDATE plan_tasks
           SET task_id_in_board = ?, status = 'running'
           WHERE plan_id = ? AND task_meta_id = ? AND task_id_in_board IS NULL`,
        )
        .run(task_id_in_board, plan_id, task_meta_id);
    })();
  }

  markTaskStatus(
    plan_id: string,
    task_meta_id: string,
    status: PlanTaskStatus,
    last_event_ts?: number | string,
  ): void {
    PlanTaskStatusSchema.parse(status);
    const normalizedLastEventTs =
      typeof last_event_ts === "string" ? Date.parse(last_event_ts) : (last_event_ts ?? null);
    const result = this.db
      .query<
        unknown,
        [string, number | null, string, string]
      >("UPDATE plan_tasks SET status = ?, last_event_ts = ? WHERE plan_id = ? AND task_meta_id = ?")
      .run(status, normalizedLastEventTs, plan_id, task_meta_id);
    if (result.changes === 0) {
      throw new PlanTaskNotFound(plan_id, task_meta_id);
    }
  }

  markPlanStatus(plan_id: string, status: PlanStatus): void {
    PlanStatusSchema.parse(status);
    const result = this.db
      .query<unknown, [string, string]>("UPDATE plans SET status = ? WHERE plan_id = ?")
      .run(status, plan_id);
    if (result.changes === 0) {
      throw new PlanNotFound(plan_id);
    }
  }

  findPlanTaskByBoardId(
    task_id_in_board: string,
  ): { plan_id: string; task_meta_id: string } | null {
    const row = this.db
      .query<
        { plan_id: string; task_meta_id: string } | null,
        [string]
      >("SELECT plan_id, task_meta_id FROM plan_tasks WHERE task_id_in_board = ? LIMIT 1")
      .get(task_id_in_board);
    return row ?? null;
  }

  private requirePlan(plan_id: string): PlanRecord {
    const row = this.db
      .query<PlanRow | null, [string]>("SELECT * FROM plans WHERE plan_id = ?")
      .get(plan_id);
    if (!row) {
      throw new PlanNotFound(plan_id);
    }
    return PlanRecordSchema.parse(row);
  }
}
