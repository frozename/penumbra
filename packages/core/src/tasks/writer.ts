import type { Database } from 'bun:sqlite';
import { enforceEmitCaps } from './emit-caps.js';
import { isEligible, type AgentDescriptor, TIER_ORDER } from './eligibility.js';
import { pickPreferred, type AgentRankRow } from './auction.js';
import type { RankAgentsFn } from './rank-bridge.js';
import { synthesizeReviewTask } from './review-pairing.js';
import { type TaskEvent, TaskEventBus } from './event-bus.js';
import {
  FileTaskInputSchema,
  LeaseTaskInputSchema,
  HeartbeatTaskInputSchema,
  CompleteTaskInputSchema,
  FailTaskInputSchema,
  CancelTaskInputSchema,
  type FileTaskInput,
  type LeaseTaskInput,
  type HeartbeatTaskInput,
  type CompleteTaskInput,
  type FailTaskInput,
  type CancelTaskInput,
  type TaskRecord,
  type TaskKind,
  type TaskStatus,
  type TaskEventKind,
  type ExpectedArtifact,
  type Eligibility,
} from './schema.js';

export class TaskNotFound extends Error {
  constructor(public readonly task_id: string) {
    super(`task not found: ${task_id}`);
    this.name = 'TaskNotFound';
  }
}

export class InvalidTaskStatus extends Error {
  constructor(
    public readonly task_id: string,
    public readonly current_status: TaskStatus,
  ) {
    super(`cannot lease task in status \`${current_status}\``);
    this.name = 'InvalidTaskStatus';
  }
}

export class LeaseConflict extends Error {
  constructor(public readonly task_id: string) {
    super(`task ${task_id} already has an open lease`);
    this.name = 'LeaseConflict';
  }
}

export class LeaseInvalid extends Error {
  constructor(
    public readonly lease_id: string,
    public readonly task_id: string,
  ) {
    super(`lease ${lease_id} is invalid for task ${task_id}`);
    this.name = 'LeaseInvalid';
  }
}

export class MissingReviewVerdict extends Error {
  constructor(public readonly task_id: string) {
    super(`review task ${task_id} requires review_verdict`);
    this.name = 'MissingReviewVerdict';
  }
}

export class UnexpectedReviewVerdict extends Error {
  constructor(public readonly task_id: string) {
    super(`work task ${task_id} cannot accept review_verdict`);
    this.name = 'UnexpectedReviewVerdict';
  }
}

export class ReviewParentInvalidState extends Error {
  constructor(
    public readonly parent_task_id: string,
    public readonly current_status: TaskStatus,
  ) {
    super(`review parent ${parent_task_id} is in invalid status ${current_status}`);
    this.name = 'ReviewParentInvalidState';
  }
}

const DEFAULT_LEASE_TTL_MS = 90_000;

export interface TaskLeaseRow {
  id: string;
  task_id: string;
  agent_id: string;
  claimed_at: number;
  expires_at: number;
  released_at: number | null;
  release_reason: string | null;
  auction_score: number | null;
}

export interface TaskEventRow {
  id: number;
  task_id: string;
  at: number;
  kind: TaskEventKind;
  actor: string | null;
  payload: unknown | null;
}

export interface TaskDescendants {
  count: number;
  depth: number;
  ids: string[];
}

export interface TaskWithIncludes extends TaskRecord {
  lease?: TaskLeaseRow | null;
  events?: TaskEventRow[];
  descendants?: TaskDescendants;
}

export type TaskInclude = 'lease' | 'events' | 'descendants';

export interface ListFilters {
  status?: TaskStatus;
  kind?: TaskKind;
  parent_task_id?: string;
  origin?: string;
  eligible_for?: string;
  cooldowns?: Map<string, Map<string, number>>;
  limit?: number;
  offset?: number;
}

export interface NextTaskInput {
  agent_id: string;
  tags?: string[];
  max_cost_cents?: number;
}

export interface NextTaskResult {
  task_id: string;
  prompt: string;
  acceptance_criteria: string | null;
  expected_artifacts: ExpectedArtifact[] | null;
  lease_id: string;
  expires_at: number;
}

interface TaskDbRow {
  id: string;
  created_at: number;
  updated_at: number;
  created_by_kind: string;
  created_by_id: string;
  parent_task_id: string | null;
  kind: string;
  priority: string;
  prompt: string;
  acceptance_criteria: string | null;
  expected_artifacts: string | null;
  eligibility: string;
  review_eligibility: string | null;
  requires_review: number;
  status: string;
  result_summary: string | null;
  result_artifacts: string | null;
  failure_reason: string | null;
  chain_id: string | null;
  origin: string | null;
}

const PRIORITY_ORDER_SQL = `
  CASE priority
    WHEN 'urgent' THEN 0
    WHEN 'high'   THEN 1
    WHEN 'normal' THEN 2
    WHEN 'low'    THEN 3
    ELSE 4
  END
`;

function publishEvents(bus: TaskEventBus | undefined, events: TaskEvent[]): void {
  if (!bus || events.length === 0) return;
  for (const event of events) {
    bus.publish(event);
  }
}

function recordEvent(events: TaskEvent[] | undefined, event: TaskEvent): void {
  events?.push(event);
}

export class TaskWriter {
  private readonly now: () => number;
  private readonly resolveAgent?: (name: string) => AgentDescriptor | undefined;
  private readonly rankAgents: RankAgentsFn;
  private readonly cooldowns?: Map<string, Map<string, number>>;
  private readonly bus?: TaskEventBus;

  constructor(
    private readonly db: Database,
    deps: (() => number) | {
      now?: () => number;
      resolveAgent?: (name: string) => AgentDescriptor | undefined;
      rankAgents?: RankAgentsFn;
      cooldowns?: Map<string, Map<string, number>>;
      bus?: TaskEventBus;
    } = {},
  ) {
    if (typeof deps === 'function') {
      this.now = deps;
      this.resolveAgent = undefined;
      this.rankAgents = async () => [];
      this.cooldowns = undefined;
      this.bus = undefined;
      return;
    }
    this.now = deps.now ?? Date.now;
    this.resolveAgent = deps.resolveAgent;
    this.rankAgents = deps.rankAgents ?? (async () => []);
    this.cooldowns = deps.cooldowns;
    this.bus = deps.bus;
  }

  file(input: FileTaskInput): { task_id: string } {
    const events: TaskEvent[] = [];
    const filed = this.db.transaction(() =>
      this._fileInTransaction(input, { emittedEvents: events }))();
    publishEvents(this.bus, events);
    return filed;
  }

  private _fileInTransaction(
    input: FileTaskInput,
    opts: { skipEmitCaps?: boolean; emittedEvents?: TaskEvent[] } = {},
  ): { task_id: string } {
    const validated = FileTaskInputSchema.parse(input);
    const task_id = `task_${crypto.randomUUID().toLowerCase()}`;
    const now = this.now();
    const kind: TaskKind = validated.kind ?? 'work';
    const priority = validated.priority ?? 'normal';
    const requires_review = validated.requires_review ?? false;
    const eligibility = JSON.stringify(validated.eligibility ?? {});
    const review_eligibility = validated.review_eligibility
      ? JSON.stringify(validated.review_eligibility)
      : null;
    const expected_artifacts = validated.expected_artifacts
      ? JSON.stringify(validated.expected_artifacts)
      : null;
    const acceptance_criteria = validated.acceptance_criteria ?? null;
    const parent_task_id = validated.parent_task_id ?? null;
    const origin = validated.origin ?? null;

    if (!opts.skipEmitCaps) {
      enforceEmitCaps(this.db, {
        producer_kind: validated.created_by_kind,
        producer_id: validated.created_by_id,
        parent_task_id: validated.parent_task_id,
        now: this.now,
      });
    }

    this.db.run(
      `INSERT INTO tasks (
        id, created_at, updated_at, created_by_kind, created_by_id,
        parent_task_id, kind, priority, prompt, acceptance_criteria,
        expected_artifacts, eligibility, review_eligibility, requires_review,
        status, result_summary, result_artifacts, failure_reason, chain_id, origin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, ?)`,
      [
        task_id,
        now,
        now,
        validated.created_by_kind,
        validated.created_by_id,
        parent_task_id,
        kind,
        priority,
        validated.prompt,
        acceptance_criteria,
        expected_artifacts,
        eligibility,
        review_eligibility,
        requires_review ? 1 : 0,
        origin,
      ],
    );
    this.db.run(
      `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
       VALUES (?, ?, 'filed', ?, NULL)`,
      [task_id, now, validated.created_by_id],
    );
    recordEvent(opts.emittedEvents, {
      task_id,
      at: now,
      kind: 'filed',
      actor: validated.created_by_id,
      payload: null,
    });

    return { task_id };
  }

  async next(input: NextTaskInput): Promise<NextTaskResult | null> {
    const resolvedAgent = this.resolveAgent?.(input.agent_id);
    if (!resolvedAgent) return null;
    const emittedEvents: TaskEvent[] = [];

    const now = this.now();
    const pending = this.db
      .query<TaskDbRow, [number]>(
        `SELECT * FROM tasks
         WHERE status = 'pending'
         ORDER BY ${PRIORITY_ORDER_SQL} ASC, created_at ASC
         LIMIT ?`,
      )
      .all(100)
      .map(hydrateTask);

    for (const candidate of pending) {
      const candidateEligible = isEligible(resolvedAgent, candidate.eligibility, {
        now,
        cooldowns: this.cooldowns,
        task_id: candidate.id,
      });
      if (!candidateEligible) continue;

      const filedRow = this.db
        .query<{ at: number }, [string]>(
          `SELECT at FROM task_events
           WHERE task_id = ? AND kind = 'filed'
           ORDER BY id DESC
           LIMIT 1`,
        )
        .get(candidate.id);
      const auctionStartedAt = filedRow?.at ?? candidate.created_at;
      const auctionWindowMs = candidate.eligibility.preference_window_ms ?? 30_000;
      const insideWindow = auctionWindowMs > 0 && (now - auctionStartedAt) < auctionWindowMs;

      let rankings: AgentRankRow[] | null = null;
      let callerScore: number | null = null;

      if (insideWindow) {
        let preferredAgent: string | null = null;

        const existingAuctioned = this.db
          .query<{ payload_json: string | null }, [string]>(
            `SELECT payload_json
             FROM task_events
             WHERE task_id = ? AND kind = 'auctioned'
             ORDER BY id DESC
             LIMIT 1`,
          )
          .get(candidate.id);

        if (existingAuctioned?.payload_json) {
          const payload = JSON.parse(existingAuctioned.payload_json) as {
            preferred_agent?: string | null;
          };
          preferredAgent = payload.preferred_agent ?? null;
        } else {
          rankings = await this.rankAgents({
            prompt: candidate.prompt,
            tags: input.tags,
          });

          const eligibleDescriptors = rankings
            .map((row) => this.resolveAgent?.(row.agent_name))
            .filter((row): row is AgentDescriptor => Boolean(row))
            .filter((row) =>
              isEligible(row, candidate.eligibility, {
                now,
                cooldowns: this.cooldowns,
                task_id: candidate.id,
              }),
            );

          const preferred = pickPreferred(rankings, eligibleDescriptors);
          preferredAgent = preferred?.agent_id ?? null;
          const auctionPayload = {
            preferred_agent: preferred?.agent_id ?? null,
            score: preferred?.score ?? null,
            window_ms: auctionWindowMs,
            started_at: auctionStartedAt,
          };

          const insertedAuctioned = this.db.run(
            `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
             SELECT ?, ?, 'auctioned', NULL, ?
             WHERE NOT EXISTS (
               SELECT 1 FROM task_events WHERE task_id = ? AND kind = 'auctioned'
             )`,
            [
              candidate.id,
              now,
              JSON.stringify(auctionPayload),
              candidate.id,
            ],
          );
          if (insertedAuctioned.changes > 0) {
            recordEvent(emittedEvents, {
              task_id: candidate.id,
              at: now,
              kind: 'auctioned',
              actor: null,
              payload: auctionPayload,
            });
          }
        }

        if (preferredAgent && preferredAgent !== input.agent_id) {
          continue;
        }
      }

      if (!rankings) {
        rankings = await this.rankAgents({
          prompt: candidate.prompt,
          tags: input.tags,
        });
      }
      callerScore = rankings.find((row) => row.agent_name === input.agent_id)?.score ?? null;

      const leased = this.db.transaction(() => {
        const taskRow = this.db
          .query<{ status: TaskStatus }, [string]>(
            `SELECT status FROM tasks WHERE id = ?`,
          )
          .get(candidate.id);
        if (!taskRow || taskRow.status !== 'pending') return null;

        const openLease = this.db
          .query<{ one: number }, [string]>(
            `SELECT 1 AS one
             FROM task_leases
             WHERE task_id = ? AND released_at IS NULL
             LIMIT 1`,
          )
          .get(candidate.id);
        if (openLease) return null;

        const ttl_ms = candidate.eligibility.heartbeat_ttl_ms ?? DEFAULT_LEASE_TTL_MS;
        const lease_id = `lease_${crypto.randomUUID().toLowerCase()}`;
        const expires_at = now + ttl_ms;

        this.db.run(
          `INSERT INTO task_leases (
             id, task_id, agent_id, claimed_at, expires_at, released_at, release_reason, auction_score
           ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
          [lease_id, candidate.id, input.agent_id, now, expires_at, callerScore],
        );
        this.db.run(
          `UPDATE tasks SET status = 'leased', updated_at = ? WHERE id = ?`,
          [now, candidate.id],
        );
        this.db.run(
          `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
           VALUES (?, ?, 'leased', ?, ?)`,
          [
            candidate.id,
            now,
            input.agent_id,
            JSON.stringify({ lease_id, ttl_ms }),
          ],
        );
        recordEvent(emittedEvents, {
          task_id: candidate.id,
          at: now,
          kind: 'leased',
          actor: input.agent_id,
          payload: { lease_id, ttl_ms },
        });

        return { lease_id, expires_at };
      })();

      if (!leased) continue;

      // TODO(task 4.1): bind rankAgents to daemon's agent_rank route for live scoring.
      const result = {
        task_id: candidate.id,
        prompt: candidate.prompt,
        acceptance_criteria: candidate.acceptance_criteria,
        expected_artifacts: candidate.expected_artifacts,
        lease_id: leased.lease_id,
        expires_at: leased.expires_at,
      };
      publishEvents(this.bus, emittedEvents);
      return result;
    }

    publishEvents(this.bus, emittedEvents);
    return null;
  }

  lease(input: LeaseTaskInput): { lease_id: string; expires_at: number } {
    const validated = LeaseTaskInputSchema.parse(input);
    const ttl_ms = validated.ttl_ms ?? DEFAULT_LEASE_TTL_MS;
    const lease_id = `lease_${crypto.randomUUID().toLowerCase()}`;
    const emittedEvents: TaskEvent[] = [];

    const lease = this.db.transaction(() => {
      const taskRow = this.db
        .query<{ status: string }, [string]>(
          `SELECT status FROM tasks WHERE id = ?`,
        )
        .get(validated.task_id);
      if (!taskRow) throw new TaskNotFound(validated.task_id);

      const openLease = this.db
        .query<{ one: number }, [string]>(
          `SELECT 1 AS one FROM task_leases WHERE task_id = ? AND released_at IS NULL LIMIT 1`,
        )
        .get(validated.task_id);
      if (openLease) throw new LeaseConflict(validated.task_id);

      if (taskRow.status !== 'pending') {
        throw new InvalidTaskStatus(validated.task_id, taskRow.status as TaskStatus);
      }

      const now = this.now();
      const expires_at = now + ttl_ms;

      this.db.run(
        `INSERT INTO task_leases (
           id, task_id, agent_id, claimed_at, expires_at, released_at, release_reason, auction_score
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
        [lease_id, validated.task_id, validated.agent_id, now, expires_at],
      );
      this.db.run(
        `UPDATE tasks SET status = 'leased', updated_at = ? WHERE id = ?`,
        [now, validated.task_id],
      );
      this.db.run(
        `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
         VALUES (?, ?, 'leased', ?, ?)`,
        [
          validated.task_id,
          now,
          validated.agent_id,
          JSON.stringify({ lease_id, ttl_ms }),
        ],
      );
      recordEvent(emittedEvents, {
        task_id: validated.task_id,
        at: now,
        kind: 'leased',
        actor: validated.agent_id,
        payload: { lease_id, ttl_ms },
      });

      return { lease_id, expires_at };
    })();
    publishEvents(this.bus, emittedEvents);
    return lease;
  }

  heartbeat(input: HeartbeatTaskInput): { expires_at: number } {
    const validated = HeartbeatTaskInputSchema.parse(input);
    const emittedEvents: TaskEvent[] = [];

    const heartbeat = this.db.transaction(() => {
      const leaseRow = this.db
        .query<
          { id: string; task_id: string; agent_id: string; claimed_at: number; expires_at: number },
          [string]
        >(
          `SELECT id, task_id, agent_id, claimed_at, expires_at
           FROM task_leases
           WHERE id = ? AND released_at IS NULL`,
        )
        .get(validated.lease_id);
      if (!leaseRow || leaseRow.task_id !== validated.task_id) {
        throw new LeaseInvalid(validated.lease_id, validated.task_id);
      }

      const now = this.now();
      const ttl_ms = leaseRow.expires_at - leaseRow.claimed_at;
      const expires_at = now + ttl_ms;

      this.db.run(
        `UPDATE task_leases SET expires_at = ? WHERE id = ?`,
        [expires_at, leaseRow.id],
      );
      this.db.run(
        `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
         VALUES (?, ?, 'heartbeat', ?, ?)`,
        [
          validated.task_id,
          now,
          leaseRow.agent_id,
          JSON.stringify({ expires_at }),
        ],
      );
      recordEvent(emittedEvents, {
        task_id: validated.task_id,
        at: now,
        kind: 'heartbeat',
        actor: leaseRow.agent_id,
        payload: { expires_at },
      });

      return { expires_at };
    })();
    publishEvents(this.bus, emittedEvents);
    return heartbeat;
  }

  complete(input: CompleteTaskInput): { status: TaskStatus } {
    const validated = CompleteTaskInputSchema.parse(input);
    const emittedEvents: TaskEvent[] = [];

    const completion = this.db.transaction(() => {
      const taskRow = this.db
        .query<
          {
            id: string;
            kind: TaskKind;
            status: TaskStatus;
            parent_task_id: string | null;
            requires_review: number;
          },
          [string]
        >(
          `SELECT id, kind, status, parent_task_id, requires_review
           FROM tasks
           WHERE id = ?`,
        )
        .get(validated.task_id);
      if (!taskRow) throw new TaskNotFound(validated.task_id);

      const leaseRow = this.db
        .query<
          { id: string; task_id: string; agent_id: string },
          [string]
        >(
          `SELECT id, task_id, agent_id
           FROM task_leases
           WHERE id = ? AND released_at IS NULL`,
        )
        .get(validated.lease_id);
      if (!leaseRow || leaseRow.task_id !== validated.task_id) {
        throw new LeaseInvalid(validated.lease_id, validated.task_id);
      }

      const now = this.now();
      let nextStatus: TaskStatus;

      if (taskRow.kind === 'review') {
        const verdict = validated.review_verdict;
        if (!verdict) throw new MissingReviewVerdict(validated.task_id);

        const parentTaskId = taskRow.parent_task_id ?? 'unknown';
        const parentRow = taskRow.parent_task_id
          ? this.db
              .query<{ status: TaskStatus }, [string]>(
                `SELECT status FROM tasks WHERE id = ?`,
              )
              .get(taskRow.parent_task_id)
          : null;
        if (!parentRow || parentRow.status !== 'done_pending_review') {
          throw new ReviewParentInvalidState(
            parentTaskId,
            parentRow?.status ?? 'cancelled',
          );
        }

        if (verdict.passed) {
          this.db.run(
            `UPDATE tasks
             SET status = 'done', updated_at = ?
             WHERE id = ?`,
            [now, taskRow.parent_task_id!],
          );
          this.db.run(
            `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
             VALUES (?, ?, 'review_passed', ?, ?)`,
            [
              taskRow.parent_task_id!,
              now,
              leaseRow.agent_id,
              JSON.stringify({ notes: verdict.notes }),
            ],
          );
          recordEvent(emittedEvents, {
            task_id: taskRow.parent_task_id!,
            at: now,
            kind: 'review_passed',
            actor: leaseRow.agent_id,
            payload: { notes: verdict.notes },
          });
        } else {
          this.db.run(
            `UPDATE tasks
             SET status = 'failed', failure_reason = ?, updated_at = ?
             WHERE id = ?`,
            [
              `review rejected: ${verdict.notes}`,
              now,
              taskRow.parent_task_id!,
            ],
          );
          this.db.run(
            `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
             VALUES (?, ?, 'review_failed', ?, ?)`,
            [
              taskRow.parent_task_id!,
              now,
              leaseRow.agent_id,
              JSON.stringify({ notes: verdict.notes }),
            ],
          );
          recordEvent(emittedEvents, {
            task_id: taskRow.parent_task_id!,
            at: now,
            kind: 'review_failed',
            actor: leaseRow.agent_id,
            payload: { notes: verdict.notes },
          });
        }

        this.db.run(
          `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
           VALUES (?, ?, 'completed', ?, ?)`,
          [
            validated.task_id,
            now,
            leaseRow.agent_id,
            JSON.stringify({ result_summary: validated.result_summary }),
          ],
        );
        recordEvent(emittedEvents, {
          task_id: validated.task_id,
          at: now,
          kind: 'completed',
          actor: leaseRow.agent_id,
          payload: { result_summary: validated.result_summary },
        });
        nextStatus = 'done';
      } else {
        if (validated.review_verdict) {
          throw new UnexpectedReviewVerdict(validated.task_id);
        }
        nextStatus = taskRow.requires_review === 1 ? 'done_pending_review' : 'done';

        this.db.run(
          `UPDATE tasks
           SET status = ?, result_summary = ?, result_artifacts = ?, chain_id = ?, updated_at = ?
           WHERE id = ?`,
          [
            nextStatus,
            validated.result_summary,
            validated.result_artifacts
              ? JSON.stringify(validated.result_artifacts)
              : null,
            validated.chain_id ?? null,
            now,
            validated.task_id,
          ],
        );
        this.db.run(
          `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
           VALUES (?, ?, 'completed', ?, ?)`,
          [
            validated.task_id,
            now,
            leaseRow.agent_id,
            JSON.stringify({ result_summary: validated.result_summary }),
          ],
        );
        recordEvent(emittedEvents, {
          task_id: validated.task_id,
          at: now,
          kind: 'completed',
          actor: leaseRow.agent_id,
          payload: { result_summary: validated.result_summary },
        });

        if (taskRow.kind === 'work' && taskRow.requires_review === 1) {
          const parentAfterUpdateRow = this.db
            .query<TaskDbRow, [string]>(
              `SELECT * FROM tasks WHERE id = ?`,
            )
            .get(validated.task_id);
          if (!parentAfterUpdateRow) throw new TaskNotFound(validated.task_id);

          const reviewInput = synthesizeReviewTask(
            hydrateTask(parentAfterUpdateRow),
            leaseRow.agent_id,
          );
          const filed = this._fileInTransaction(reviewInput, {
            skipEmitCaps: true,
            emittedEvents,
          });

          this.db.run(
            `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
             VALUES (?, ?, 'review_filed', 'system', ?)`,
            [
              validated.task_id,
              now,
              JSON.stringify({ review_task_id: filed.task_id }),
            ],
          );
          recordEvent(emittedEvents, {
            task_id: validated.task_id,
            at: now,
            kind: 'review_filed',
            actor: 'system',
            payload: { review_task_id: filed.task_id },
          });
        }
      }

      if (taskRow.kind === 'review') {
        this.db.run(
          `UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?`,
          [now, validated.task_id],
        );
      }

      this.db.run(
        `UPDATE task_leases
         SET released_at = ?, release_reason = 'completed'
         WHERE id = ?`,
        [now, validated.lease_id],
      );

      if (taskRow.kind === 'review') {
        this.db.run(
          `UPDATE tasks SET updated_at = ? WHERE id = ?`,
          [now, validated.task_id],
        );
      }

      return { status: nextStatus };
    })();
    publishEvents(this.bus, emittedEvents);
    return completion;
  }

  fail(input: FailTaskInput): { status: 'failed' } {
    const validated = FailTaskInputSchema.parse(input);
    const emittedEvents: TaskEvent[] = [];

    const failed = this.db.transaction(() => {
      const taskRow = this.db
        .query<{ id: string; kind: TaskKind; parent_task_id: string | null; eligibility: string }, [string]>(
          `SELECT id, kind, parent_task_id, eligibility FROM tasks WHERE id = ?`,
        )
        .get(validated.task_id);
      if (!taskRow) throw new TaskNotFound(validated.task_id);

      const leaseRow = this.db
        .query<{ id: string; task_id: string; agent_id: string }, [string]>(
          `SELECT id, task_id, agent_id
           FROM task_leases
           WHERE id = ? AND released_at IS NULL`,
        )
        .get(validated.lease_id);
      if (!leaseRow || leaseRow.task_id !== validated.task_id) {
        throw new LeaseInvalid(validated.lease_id, validated.task_id);
      }

      const now = this.now();
      this.db.run(
        `UPDATE task_leases
         SET released_at = ?, release_reason = 'failed'
         WHERE id = ?`,
        [now, validated.lease_id],
      );
      this.db.run(
        `UPDATE tasks
         SET status = 'failed', failure_reason = ?, updated_at = ?
         WHERE id = ?`,
        [validated.reason, now, validated.task_id],
      );
      this.db.run(
        `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
         VALUES (?, ?, 'completed', ?, ?)`,
        [
          validated.task_id,
          now,
          leaseRow.agent_id,
          JSON.stringify({ success: false, reason: validated.reason }),
        ],
      );
      recordEvent(emittedEvents, {
        task_id: validated.task_id,
        at: now,
        kind: 'completed',
        actor: leaseRow.agent_id,
        payload: { success: false, reason: validated.reason },
      });

      if (taskRow.kind === 'review' && taskRow.parent_task_id) {
        const parentRow = this.db
          .query<{ id: string; status: TaskStatus }, [string]>(
            `SELECT id, status FROM tasks WHERE id = ?`,
          )
          .get(taskRow.parent_task_id);

        if (parentRow && parentRow.status === 'done_pending_review') {
          const attemptsRow = this.db
            .query<{ attempts: number }, [string]>(
              `SELECT COUNT(*) AS attempts
               FROM tasks
               WHERE parent_task_id = ? AND kind = 'review'`,
            )
            .get(taskRow.parent_task_id);
          const attempts = attemptsRow?.attempts ?? 0;

          if (attempts < 3) {
            const originalReviewRow = this.db
              .query<{ eligibility: string }, [string]>(
                `SELECT eligibility
                 FROM tasks
                 WHERE parent_task_id = ? AND kind = 'review'
                 ORDER BY created_at ASC, id ASC
                 LIMIT 1`,
              )
              .get(taskRow.parent_task_id);

            let originalDenyAgents: string[] = [];
            if (originalReviewRow?.eligibility) {
              const parsed = JSON.parse(originalReviewRow.eligibility) as { deny_agents?: unknown };
              originalDenyAgents = Array.isArray(parsed.deny_agents)
                ? parsed.deny_agents.filter((value): value is string => typeof value === 'string')
                : [];
            }

            const currentEligibility = JSON.parse(taskRow.eligibility) as { deny_agents?: unknown };
            const currentDenyAgents = Array.isArray(currentEligibility.deny_agents)
              ? currentEligibility.deny_agents.filter((value): value is string => typeof value === 'string')
              : [];

            const parentTaskRow = this.db
              .query<TaskDbRow, [string]>(
                `SELECT * FROM tasks WHERE id = ?`,
              )
              .get(taskRow.parent_task_id);

            if (parentTaskRow) {
              const doerAgentId = originalDenyAgents[0] ?? leaseRow.agent_id;
              const reviewInput = synthesizeReviewTask(
                hydrateTask(parentTaskRow),
                doerAgentId,
                [...currentDenyAgents, leaseRow.agent_id],
              );
              const filed = this._fileInTransaction(reviewInput, {
                skipEmitCaps: true,
                emittedEvents,
              });

              this.db.run(
                `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
                 VALUES (?, ?, 'review_filed', 'system', ?)`,
                [
                  parentTaskRow.id,
                  now,
                  JSON.stringify({ review_task_id: filed.task_id }),
                ],
              );
              recordEvent(emittedEvents, {
                task_id: parentTaskRow.id,
                at: now,
                kind: 'review_filed',
                actor: 'system',
                payload: { review_task_id: filed.task_id },
              });
            }
          } else {
            this.db.run(
              `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
               VALUES (?, ?, 'review_failed', ?, ?)`,
              [
                taskRow.parent_task_id,
                now,
                leaseRow.agent_id,
                JSON.stringify({
                  retries_exhausted: true,
                  last_reviewer: leaseRow.agent_id,
                  last_notes: validated.reason,
                }),
              ],
            );
            recordEvent(emittedEvents, {
              task_id: taskRow.parent_task_id,
              at: now,
              kind: 'review_failed',
              actor: leaseRow.agent_id,
              payload: {
                retries_exhausted: true,
                last_reviewer: leaseRow.agent_id,
                last_notes: validated.reason,
              },
            });
          }
        }
      }

      return { status: 'failed' as const };
    })();
    publishEvents(this.bus, emittedEvents);
    return failed;
  }

  cancel(input: CancelTaskInput): { status: 'cancelled' } {
    const validated = CancelTaskInputSchema.parse(input);
    const emittedEvents: TaskEvent[] = [];

    const cancelled = this.db.transaction(() => {
      const taskRow = this.db
        .query<{ status: TaskStatus }, [string]>(
          `SELECT status FROM tasks WHERE id = ?`,
        )
        .get(validated.task_id);
      if (!taskRow) throw new TaskNotFound(validated.task_id);

      if (taskRow.status === 'done' || taskRow.status === 'failed' || taskRow.status === 'cancelled') {
        throw new InvalidTaskStatus(validated.task_id, taskRow.status);
      }

      const now = this.now();
      const openLease = this.db
        .query<{ id: string }, [string]>(
          `SELECT id FROM task_leases WHERE task_id = ? AND released_at IS NULL LIMIT 1`,
        )
        .get(validated.task_id);
      if (openLease) {
        this.db.run(
          `UPDATE task_leases
           SET released_at = ?, release_reason = 'cancelled'
           WHERE id = ?`,
          [now, openLease.id],
        );
      }

      this.db.run(
        `UPDATE tasks
         SET status = 'cancelled', failure_reason = ?, updated_at = ?
         WHERE id = ?`,
        [validated.reason ?? null, now, validated.task_id],
      );
      this.db.run(
        `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
         VALUES (?, ?, 'cancelled', NULL, ?)`,
        [
          validated.task_id,
          now,
          JSON.stringify({ reason: validated.reason }),
        ],
      );
      recordEvent(emittedEvents, {
        task_id: validated.task_id,
        at: now,
        kind: 'cancelled',
        actor: null,
        payload: { reason: validated.reason },
      });

      return { status: 'cancelled' as const };
    })();
    publishEvents(this.bus, emittedEvents);
    return cancelled;
  }

  get(task_id: string, opts?: { include?: TaskInclude[] }): TaskWithIncludes {
    const row = this.db
      .query<TaskDbRow, [string]>(`SELECT * FROM tasks WHERE id = ?`)
      .get(task_id);
    if (!row) throw new TaskNotFound(task_id);

    const result: TaskWithIncludes = hydrateTask(row);
    const include = opts?.include ?? [];

    if (include.includes('lease')) {
      const leaseRow = this.db
        .query<TaskLeaseRow, [string]>(
          `SELECT id, task_id, agent_id, claimed_at, expires_at, released_at, release_reason, auction_score
           FROM task_leases
           WHERE task_id = ? AND released_at IS NULL
           LIMIT 1`,
        )
        .get(task_id);
      result.lease = leaseRow ?? null;
    }

    if (include.includes('events')) {
      const eventRows = this.db
        .query<
          { id: number; task_id: string; at: number; kind: string; actor: string | null; payload_json: string | null },
          [string]
        >(
          `SELECT id, task_id, at, kind, actor, payload_json
           FROM task_events
           WHERE task_id = ?
           ORDER BY id ASC
           LIMIT 100`,
        )
        .all(task_id);
      result.events = eventRows.map(r => ({
        id: r.id,
        task_id: r.task_id,
        at: r.at,
        kind: r.kind as TaskEventKind,
        actor: r.actor,
        payload: r.payload_json ? JSON.parse(r.payload_json) : null,
      }));
    }

    if (include.includes('descendants')) {
      const rows = this.db
        .query<{ id: string; depth: number }, [string]>(
          `WITH RECURSIVE descendants(id, depth) AS (
             SELECT id, 1 FROM tasks WHERE parent_task_id = ?
             UNION ALL
             SELECT t.id, d.depth + 1
               FROM tasks t
               INNER JOIN descendants d ON t.parent_task_id = d.id
           )
           SELECT id, depth FROM descendants`,
        )
        .all(task_id);
      const ids = rows.map(r => r.id);
      const maxDepth = rows.reduce((m, r) => Math.max(m, r.depth), 0);
      result.descendants = { count: rows.length, depth: maxDepth, ids };
    }

    return result;
  }

  list(filters: ListFilters = {}): TaskRecord[] {
    if (filters.eligible_for && !this.resolveAgent) return [];
    const resolvedAgent = filters.eligible_for
      ? this.resolveAgent?.(filters.eligible_for)
      : undefined;
    if (filters.eligible_for && !resolvedAgent) return [];
    if (filters.eligible_for && filters.status && filters.status !== 'pending') return [];

    const where: string[] = [];
    const params: Array<string | number> = [];

    if (filters.status !== undefined) {
      where.push('status = ?');
      params.push(filters.status);
    }
    if (filters.kind !== undefined) {
      where.push('kind = ?');
      params.push(filters.kind);
    }
    if (filters.parent_task_id !== undefined) {
      where.push('parent_task_id = ?');
      params.push(filters.parent_task_id);
    }
    if (filters.origin !== undefined) {
      where.push('origin = ?');
      params.push(filters.origin);
    }
    if (filters.eligible_for && filters.status === undefined) {
      where.push('status = ?');
      params.push('pending');
    }
    if (filters.eligible_for && resolvedAgent) {
      const tier = resolvedAgent.tier;
      const agentRank = TIER_ORDER.indexOf(tier as (typeof TIER_ORDER)[number]);
      if (agentRank >= 0) {
        const eligibleMinTiers = TIER_ORDER.slice(0, agentRank + 1);
        const placeholders = eligibleMinTiers.map(() => '?').join(', ');
        where.push(
          `(json_extract(eligibility, '$.min_tier') IS NULL
            OR json_extract(eligibility, '$.min_tier') NOT IN (${TIER_ORDER.map(() => '?').join(', ')})
            OR json_extract(eligibility, '$.min_tier') IN (${placeholders}))`,
        );
        params.push(...TIER_ORDER, ...eligibleMinTiers);
      } else {
        where.push(
          `(json_extract(eligibility, '$.min_tier') IS NULL
            OR json_extract(eligibility, '$.min_tier') NOT IN (${TIER_ORDER.map(() => '?').join(', ')}))`,
        );
        params.push(...TIER_ORDER);
      }
    }

    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const sql = `
      SELECT * FROM tasks
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${PRIORITY_ORDER_SQL} ASC, created_at ASC
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const rows = this.db.query<TaskDbRow, (string | number)[]>(sql).all(...params);
    const hydrated = rows.map(hydrateTask);
    if (!resolvedAgent) return hydrated;

    const now = this.now();
    return hydrated.filter((row) =>
      isEligible(resolvedAgent, row.eligibility, {
        now,
        cooldowns: filters.cooldowns,
        task_id: row.id,
      }),
    );
  }
}

function hydrateTask(row: TaskDbRow): TaskRecord {
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by_kind: row.created_by_kind as TaskRecord['created_by_kind'],
    created_by_id: row.created_by_id,
    parent_task_id: row.parent_task_id,
    kind: row.kind as TaskKind,
    priority: row.priority as TaskRecord['priority'],
    prompt: row.prompt,
    acceptance_criteria: row.acceptance_criteria,
    expected_artifacts: row.expected_artifacts
      ? (JSON.parse(row.expected_artifacts) as ExpectedArtifact[])
      : null,
    eligibility: JSON.parse(row.eligibility) as Eligibility,
    review_eligibility: row.review_eligibility
      ? (JSON.parse(row.review_eligibility) as Eligibility)
      : null,
    requires_review: row.requires_review === 1,
    status: row.status as TaskStatus,
    result_summary: row.result_summary,
    result_artifacts: row.result_artifacts
      ? (JSON.parse(row.result_artifacts) as ExpectedArtifact[])
      : null,
    failure_reason: row.failure_reason,
    chain_id: row.chain_id,
    origin: row.origin,
  };
}
