import type { Database } from "bun:sqlite";

export interface PressureSnapshot {
  provider: string;
  window_label: string;
  model: string | null;
  used_pct: number;
  resets_at: number | null;
  observed_at: string;
  source_kind: string;
}

export interface PressureWarning {
  code: "stale_snapshot";
  provider: string;
  window_label: string;
  // Model dimension of the stale snapshot. Must be present (null for
  // model-less snapshots) so stale-key comparisons match the snapshot's
  // (provider, window_label, model) identity exactly. Without this, a stale
  // per-model warning would mask a fresh global (model=null) snapshot and
  // vice versa — see the reader group key.
  model: string | null;
  age_seconds: number;
}

export interface PressureResult {
  snapshots: PressureSnapshot[];
  warnings: PressureWarning[];
}

export interface ReadSubscriptionPressureOpts {
  stale_after_seconds?: number;
  provider?: string;
  now?: () => Date;
}

type SnapshotRow = {
  provider: string;
  window_label: string;
  ts: string;
  payload_json: string;
};

export function readSubscriptionPressure(
  db: Database,
  opts: ReadSubscriptionPressureOpts = {},
): PressureResult {
  const now = opts.now ?? ((): Date => new Date());
  const staleAfterSeconds = opts.stale_after_seconds ?? 1800;
  const rows = (
    opts.provider
      ? db
          .prepare(
            `
        SELECT ts, provider, payload_json
        FROM t0_events
        WHERE event_type = 'rate-limit-snapshot'
          AND provider = ?
        ORDER BY ts DESC
      `,
          )
          .all(opts.provider)
      : db
          .prepare(
            `
        SELECT ts, provider, payload_json
        FROM t0_events
        WHERE event_type = 'rate-limit-snapshot'
        ORDER BY ts DESC
      `,
          )
          .all()
  ) as SnapshotRow[];

  const latestByGroup = new Map<string, PressureSnapshot>();
  const retiredGroups = new Set<string>();
  const warnings: PressureWarning[] = [];
  const nowMs = now().getTime();

  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as {
      window_label: string;
      model?: string | null;
      used_pct: number;
      resets_at: number | null;
      source_kind: string;
      retired?: boolean;
    };
    const key = `${row.provider}\u0000${payload.window_label}\u0000${payload.model ?? ""}`;
    if (latestByGroup.has(key) || retiredGroups.has(key)) continue;
    // A tombstone row means upstream retired the window: the group is gone,
    // not stale — drop it with no warning. Rows arrive ts-DESC, so a real
    // observation newer than a tombstone is seen first and resurrects the
    // group without ever touching retiredGroups.
    if (payload.retired === true) {
      retiredGroups.add(key);
      continue;
    }

    const snapshot: PressureSnapshot = {
      provider: row.provider,
      window_label: payload.window_label,
      model: payload.model ?? null,
      used_pct: payload.used_pct,
      resets_at: payload.resets_at ?? null,
      observed_at: row.ts,
      source_kind: payload.source_kind,
    };
    latestByGroup.set(key, snapshot);

    const ageSeconds = (nowMs - new Date(row.ts).getTime()) / 1000;
    if (ageSeconds > staleAfterSeconds) {
      warnings.push({
        code: "stale_snapshot",
        provider: row.provider,
        window_label: payload.window_label,
        model: payload.model ?? null,
        age_seconds: Math.floor(ageSeconds),
      });
    }
  }

  return {
    snapshots: [...latestByGroup.values()],
    warnings,
  };
}
