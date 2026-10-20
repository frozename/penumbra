import type { Database } from "bun:sqlite";

export const RESETS_AT_MAX_FUTURE_S = 32 * 86400;
export const RESETS_AT_MAX_PAST_S = 366 * 86400;

export interface PressureSnapshot {
  provider: string;
  window_label: string;
  model: string | null;
  used_pct: number;
  resets_at: number | null;
  observed_at: string;
  source_kind: string;
}

export type PressureWindowStatus = "fresh" | "stale" | "expired";
export interface PressureWindow extends PressureSnapshot {
  status: PressureWindowStatus;
}

export interface PressureWarning {
  code: "stale_snapshot" | "expired_window" | "implausible_resets_at";
  provider: string;
  window_label: string;
  // Model dimension of the stale or expired snapshot. Must be present (null for
  // model-less snapshots) so stale-key comparisons match the snapshot's
  // (provider, window_label, model) identity exactly. Without this, a stale
  // per-model warning would mask a fresh global (model=null) snapshot and
  // vice versa — see the reader group key.
  model: string | null;
  age_seconds: number;
  expired_for_seconds?: number;
  raw_resets_at?: number;
}

export interface PressureResult {
  snapshots: PressureSnapshot[];
  warnings: PressureWarning[];
}

export interface ReadSubscriptionPressureOpts {
  stale_after_seconds?: number;
  provider?: string;
  since?: string;
  projectId?: string | null;
  now?: () => Date;
}

type SnapshotRow = {
  provider: string;
  ts: string;
  payload_json: string;
};

export function pressureSnapshotKey(snapshot: {
  provider: string;
  window_label: string;
  model: string | null;
}): string {
  return `${snapshot.provider}\u0000${snapshot.window_label}\u0000${snapshot.model ?? ""}`;
}

export function readSubscriptionPressureWindows(
  db: Database,
  opts: ReadSubscriptionPressureOpts = {},
): { windows: PressureWindow[]; warnings: PressureWarning[] } {
  const now = opts.now ?? ((): Date => new Date());
  const staleAfterSeconds = opts.stale_after_seconds ?? 1800;
  const rows = db
    .prepare(
      `
    SELECT ts, provider, payload_json
    FROM t0_events
    WHERE event_type = 'rate-limit-snapshot'
      AND (? IS NULL OR provider = ?)
      AND (? IS NULL OR ts >= ?)
      AND (? IS NULL OR project_id = ?)
      AND provider IS NOT NULL
    ORDER BY julianday(ts) DESC, rowid DESC
  `,
    )
    .all(
      opts.provider ?? null,
      opts.provider ?? null,
      opts.since ?? null,
      opts.since ?? null,
      opts.projectId ?? null,
      opts.projectId ?? null,
    ) as SnapshotRow[];

  const windows: PressureWindow[] = [];
  const seenGroups = new Set<string>();
  const warnings: PressureWarning[] = [];
  const nowMs = now().getTime();

  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as SnapshotPayload;
    // Identity uses payload_json.model, matching routing; the poller writes
    // the column and payload model from the same value.
    const key = pressureSnapshotKey({
      provider: row.provider,
      window_label: payload.window_label,
      model: payload.model ?? null,
    });
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    // Explicitly retired groups disappear silently; elapsed resets instead emit
    // expired_window warnings. A newer live observation resurrects either group.
    if (payload.retired === true) {
      continue;
    }

    windows.push(buildWindow(row, payload, nowMs, staleAfterSeconds, warnings));
  }

  return {
    windows,
    warnings,
  };
}

function plausibleReset(
  raw: number | null,
  row: SnapshotRow,
  payload: { window_label: string; model?: string | null },
  ageSeconds: number,
  warnings: PressureWarning[],
): number | null {
  if (typeof raw !== "number") return null;
  const resetsS = raw > 1e11 ? raw / 1000 : raw;
  const obsS = Date.parse(row.ts) / 1000;
  if (
    Number.isFinite(raw) &&
    Number.isFinite(obsS) &&
    resetsS >= obsS - RESETS_AT_MAX_PAST_S &&
    resetsS <= obsS + RESETS_AT_MAX_FUTURE_S
  )
    return resetsS;
  warnings.push({
    code: "implausible_resets_at",
    provider: row.provider,
    window_label: payload.window_label,
    model: payload.model ?? null,
    age_seconds: Math.floor(ageSeconds),
    raw_resets_at: raw,
  });
  return null;
}

type SnapshotPayload = {
  window_label: string;
  model?: string | null;
  used_pct: number;
  resets_at: number | null;
  source_kind: string;
  retired?: boolean;
};

function buildWindow(
  row: SnapshotRow,
  payload: SnapshotPayload,
  nowMs: number,
  staleAfterSeconds: number,
  warnings: PressureWarning[],
): PressureWindow {
  const ageSeconds = (nowMs - Date.parse(row.ts)) / 1000;
  const resetsAt = plausibleReset(payload.resets_at, row, payload, ageSeconds, warnings);
  const snapshot: PressureSnapshot = {
    provider: row.provider,
    window_label: payload.window_label,
    model: payload.model ?? null,
    used_pct: payload.used_pct,
    resets_at: resetsAt,
    observed_at: row.ts,
    source_kind: payload.source_kind,
  };
  const status = windowStatus(snapshot, nowMs / 1000, ageSeconds, staleAfterSeconds, warnings);
  return { ...snapshot, status };
}

function windowStatus(
  snapshot: PressureSnapshot,
  nowS: number,
  ageSeconds: number,
  staleAfterSeconds: number,
  warnings: PressureWarning[],
): PressureWindowStatus {
  const identity = {
    provider: snapshot.provider,
    window_label: snapshot.window_label,
    model: snapshot.model,
    age_seconds: Math.floor(ageSeconds),
  };
  // Admission resumes at the reset instant itself; only future windows throttle.
  if (snapshot.resets_at !== null && snapshot.resets_at <= nowS) {
    warnings.push({
      code: "expired_window",
      expired_for_seconds: nowS - snapshot.resets_at,
      ...identity,
    });
    return "expired";
  }
  if (ageSeconds > staleAfterSeconds) {
    warnings.push({ code: "stale_snapshot", ...identity });
    return "stale";
  }
  return "fresh";
}

export function readSubscriptionPressure(
  db: Database,
  opts: ReadSubscriptionPressureOpts = {},
): PressureResult {
  const { windows, warnings } = readSubscriptionPressureWindows(db, opts);
  return {
    snapshots: windows
      .filter((window) => window.status !== "expired")
      .map(({ status: _status, ...snapshot }) => snapshot),
    warnings,
  };
}
