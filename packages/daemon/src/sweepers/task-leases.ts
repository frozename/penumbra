import type { Database } from "bun:sqlite";
import type { TaskCooldowns, TaskEventBus } from "@penumbra/core";
import { enqueueGhStatusSyncOnDb } from "@penumbra/core";

export interface TaskLeaseSweeperOpts {
  db: Database;
  intervalMs?: number;
  ttlMsCooldown?: number;
  now?: () => number;
  cooldowns: TaskCooldowns;
  bus?: TaskEventBus;
}

interface ExpiredLeaseRow {
  id: string;
  task_id: string;
  agent_id: string;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 600_000;

export function createTaskLeaseSweeper(opts: TaskLeaseSweeperOpts): {
  start(): void;
  stop(): void;
  tick(): void;
} {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const ttlMsCooldown = opts.ttlMsCooldown ?? DEFAULT_COOLDOWN_MS;
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | null = null;

  const releaseLease = opts.db.transaction(
    (leaseId: string, taskId: string, releasedAt: number, cooldownUntil: number): boolean => {
      const leaseUpdate = opts.db
        .query<unknown, [number, string]>(
          `UPDATE task_leases
           SET released_at = ?, release_reason = 'expired'
           WHERE id = ? AND released_at IS NULL`,
        )
        .run(releasedAt, leaseId);
      if (leaseUpdate.changes === 0) {
        return false;
      }

      opts.db
        .query<
          unknown,
          [number, string]
        >(`UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?`)
        .run(releasedAt, taskId);

      // Raw-SQL reclaim bypasses TaskWriter, so re-establish the gh status-sync
      // enqueue invariant here (no-op unless the task is gh-linked).
      enqueueGhStatusSyncOnDb(opts.db, releasedAt, taskId, "leased", "pending");

      opts.db
        .query<unknown, [string, number, string]>(
          `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
           VALUES (?, ?, 'released', NULL, ?)`,
        )
        .run(
          taskId,
          releasedAt,
          JSON.stringify({ reason: "expired", cooldown_until: cooldownUntil, lease_id: leaseId }),
        );

      return true;
    },
  );

  const api = {
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        try {
          api.tick();
        } catch {
          // keep sweeper alive across transient tick failures
        }
      }, intervalMs);
      if (typeof (timer as any).unref === "function") {
        (timer as any).unref();
      }
    },

    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },

    tick(): void {
      const nowMs = now();
      opts.cooldowns.prune(nowMs);

      const expired = opts.db
        .query<ExpiredLeaseRow, [number]>(
          `SELECT id, task_id, agent_id
           FROM task_leases
           WHERE released_at IS NULL AND expires_at < ?`,
        )
        .all(nowMs);

      if (expired.length === 0) return;
      const cooldownUntil = nowMs + ttlMsCooldown;

      for (const lease of expired) {
        const released = releaseLease(lease.id, lease.task_id, nowMs, cooldownUntil);
        if (released) {
          opts.bus?.publish({
            task_id: lease.task_id,
            at: nowMs,
            kind: "released",
            actor: null,
            payload: { reason: "expired", cooldown_until: cooldownUntil, lease_id: lease.id },
          });
          opts.cooldowns.add(lease.task_id, lease.agent_id, cooldownUntil);
        }
      }
    },
  };

  return api;
}
