import type { Database } from 'bun:sqlite';

export interface RecallStatus {
  tiers: { t0: number; t1: number; t2: number };
  t2_by_obs_type: Record<string, number>;
  t2_by_severity: Record<string, number>;
  t1_unpromoted: number;
  t1_failed: number;
  corpora: number;
  last_recall_ts?: string;
}

export function recallStatus(db: Database): RecallStatus {
  const tiers = {
    t0: db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t0_events`).get()?.c ?? 0,
    t1: db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t1_rollups`).get()?.c ?? 0,
    t2: db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t2_memories`).get()?.c ?? 0,
  };

  const histo = (rows: Array<{ k: string | null; c: number }>): Record<string, number> =>
    Object.fromEntries(rows.filter((r) => r.k !== null).map((r) => [r.k as string, r.c]));

  const t2ByType = histo(
    db
      .query<{ k: string | null; c: number }, []>(
        `SELECT obs_type AS k, COUNT(*) AS c FROM t2_memories GROUP BY obs_type`,
      )
      .all(),
  );
  const t2BySev = histo(
    db
      .query<{ k: string | null; c: number }, []>(
        `SELECT severity AS k, COUNT(*) AS c FROM t2_memories GROUP BY severity`,
      )
      .all(),
  );

  const t1Unpromoted =
    db
      .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t1_rollups WHERE t2_promoted_at IS NULL`)
      .get()?.c ?? 0;
  const t1Failed =
    db
      .query<{ c: number }, []>(
        `SELECT COUNT(*) AS c FROM t1_rollups WHERE failed_promotion_attempts > 0`,
      )
      .get()?.c ?? 0;
  const corpora = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM corpora`).get()?.c ?? 0;
  const lastRecall =
    db.query<{ ts: string | null }, []>(`SELECT MAX(ts) AS ts FROM recall_audit`).get()?.ts ?? undefined;

  return {
    tiers,
    t2_by_obs_type: t2ByType,
    t2_by_severity: t2BySev,
    t1_unpromoted: t1Unpromoted,
    t1_failed: t1Failed,
    corpora,
    ...(lastRecall ? { last_recall_ts: lastRecall } : {}),
  };
}
