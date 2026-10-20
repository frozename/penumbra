import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { applySchema } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { readRecentSubscriptionPressureSnapshots } from "@src/readers/cost.js";
import {
  readSubscriptionPressure as readPressure,
  type ReadSubscriptionPressureOpts,
} from "@src/readers/subscription-pressure.js";
import { buildPressureExcludedKeys } from "@src/services/agent-routing.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

function readSubscriptionPressure(
  db: Database,
  opts: ReadSubscriptionPressureOpts = {},
): ReturnType<typeof readPressure> {
  return readPressure(db, { now: () => new Date("2026-05-08T01:00:00Z"), ...opts });
}

function makeDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  return db;
}

function insertSnapshotRow(
  db: Database,
  row: {
    event_id: string;
    ts: string;
    provider: string;
    window_label: string;
    model?: string | null;
    used_pct: number;
    resets_at: number | null;
    source_kind: string;
    retired?: boolean;
  },
): void {
  db.prepare(
    `
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, user_id, machine_id,
      event_type, lane, provider, payload_json
    ) VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'rate-limit-snapshot', 'cli-subscription', ?, ?)
  `,
  ).run(
    row.event_id,
    row.ts,
    row.ts,
    row.provider,
    JSON.stringify({
      window_label: row.window_label,
      model: row.model ?? null,
      used_pct: row.used_pct,
      resets_at: row.resets_at,
      source_kind: row.source_kind,
      ...(row.retired === true ? { retired: true } : {}),
    }),
  );
}

describe("readSubscriptionPressure", () => {
  it("reports elapsed reset time separately from observation age without rounding", () => {
    const db = makeDb();
    const now = new Date("2026-10-01T12:00:00.500Z");
    insertSnapshotRow(db, {
      event_id: "elapsed-reset",
      ts: "2026-10-01T11:59:00Z",
      provider: "openai",
      window_label: "primary",
      used_pct: 99,
      resets_at: now.getTime() / 1000 - 0.5,
      source_kind: "local-state-codex-rollout",
    });
    const result = readSubscriptionPressure(db, { now: () => now });
    expect(result.snapshots).toEqual([]);
    expect(result.warnings[0]).toMatchObject({ age_seconds: 60, expired_for_seconds: 0.5 });
    db.close();
  });

  it("agrees with the cost reader on retirement, expiry, model groups and rowid ties", () => {
    const db = makeDb();
    const now = new Date("2026-10-01T12:00:00Z");
    const base = {
      ts: now.toISOString(),
      provider: "openai",
      window_label: "secondary",
      used_pct: 98,
      resets_at: null,
      source_kind: "local-state-codex-rollout",
    };
    insertSnapshotRow(db, { ...base, event_id: "old-live" });
    insertSnapshotRow(db, { ...base, event_id: "retirement", retired: true });
    insertSnapshotRow(db, {
      ...base,
      event_id: "expired",
      model: "expired",
      resets_at: now.getTime() / 1000,
    });
    insertSnapshotRow(db, { ...base, event_id: "tie-first", model: "live", used_pct: 20 });
    insertSnapshotRow(db, { ...base, event_id: "tie-last", model: "live", used_pct: 30 });
    const pressure = readSubscriptionPressure(db, { now: () => now });
    expect(pressure.snapshots).toHaveLength(1);
    expect(pressure.snapshots[0]).toMatchObject({ model: "live", used_pct: 30 });
    const reported = readRecentSubscriptionPressureSnapshots(db, {
      since: "2026-10-01T00:00:00Z",
      now: () => now,
    });
    expect(
      reported
        .filter((window) => window.status !== "expired")
        .map(({ status: _status, ...snapshot }) => snapshot),
    ).toEqual(pressure.snapshots);
    db.close();
  });

  for (const [offset, counts] of [
    [0, false],
    [1, true],
  ] as const) {
    it(`counts resets_at == now + ${String(offset)} as ${counts ? "live" : "expired"}`, () => {
      const db = makeDb();
      const now = new Date("2026-10-01T12:00:00Z");
      insertSnapshotRow(db, {
        event_id: "boundary",
        ts: now.toISOString(),
        provider: "openai",
        window_label: "primary",
        used_pct: 99,
        resets_at: now.getTime() / 1000 + offset,
        source_kind: "local-state-codex-rollout",
      });
      const result = readSubscriptionPressure(db, { now: () => now });
      expect(result.snapshots).toHaveLength(counts ? 1 : 0);
      expect(result.warnings).toHaveLength(counts ? 0 : 1);
      db.close();
    });
  }

  it("normalizes millisecond resets before expiry and in live snapshots", () => {
    const db = makeDb();
    const now = new Date("2026-10-01T12:00:00Z");
    const base = {
      ts: "2026-10-01T11:59:00Z",
      provider: "openai",
      used_pct: 99,
      source_kind: "local-state-codex-rollout",
    };
    insertSnapshotRow(db, {
      ...base,
      event_id: "expired-ms",
      window_label: "secondary",
      resets_at: now.getTime() - 2000,
    });
    insertSnapshotRow(db, {
      ...base,
      event_id: "live-ms",
      window_label: "primary",
      resets_at: now.getTime() + 1000,
    });
    const result = readSubscriptionPressure(db, { now: () => now });
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.resets_at).toBe(now.getTime() / 1000 + 1);
    expect(result.warnings).toEqual([
      {
        code: "expired_window",
        provider: "openai",
        window_label: "secondary",
        model: null,
        age_seconds: 60,
        expired_for_seconds: 2,
      },
    ]);
    db.close();
  });

  it("excludes expired latest windows without reviving older usage and preserves warning identity", () => {
    const db = makeDb();
    const now = new Date("2026-10-01T12:00:00.000Z");
    const snapshot = {
      event_id: "older",
      ts: "2026-10-01T10:00:00.000Z",
      provider: "openai",
      window_label: "secondary",
      model: "codex",
      used_pct: 98,
      resets_at: now.getTime() / 1000 + 3600,
      source_kind: "local-state-codex-rollout",
    };
    insertSnapshotRow(db, snapshot);
    insertSnapshotRow(db, {
      ...snapshot,
      event_id: "expired",
      ts: "2026-10-01T11:00:00.000Z",
      resets_at: now.getTime() / 1000,
    });
    insertSnapshotRow(db, {
      ...snapshot,
      event_id: "expired-global",
      model: null,
      resets_at: now.getTime() / 1000 - 1,
    });
    insertSnapshotRow(db, {
      ...snapshot,
      event_id: "no-reset",
      window_label: "primary",
      resets_at: null,
    });
    insertSnapshotRow(db, {
      ...snapshot,
      event_id: "future",
      provider: "other",
      resets_at: now.getTime() / 1000 + 1,
    });
    const out = readSubscriptionPressure(db, { now: () => now });
    expect(out.snapshots.map((s) => [s.provider, s.window_label]).sort()).toEqual([
      ["openai", "primary"],
      ["other", "secondary"],
    ]);
    expect(
      out.warnings.filter((w) => w.window_label === "secondary" && w.provider === "openai"),
    ).toEqual([
      {
        code: "expired_window",
        provider: "openai",
        window_label: "secondary",
        model: "codex",
        age_seconds: 3600,
        expired_for_seconds: 0,
      },
      {
        code: "expired_window",
        provider: "openai",
        window_label: "secondary",
        model: null,
        age_seconds: 7200,
        expired_for_seconds: 1,
      },
    ]);
    db.close();
  });

  it("returns empty snapshots and warnings for an empty database", () => {
    const db = makeDb();
    expect(readSubscriptionPressure(db)).toEqual({ snapshots: [], warnings: [] });
  });

  it("keeps only the most recent snapshot per provider and window", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 1778284900,
      source_kind: "local-state-claude-statusline",
    });
    insertSnapshotRow(db, {
      event_id: "b",
      ts: "2026-05-08T00:10:00Z",
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 20,
      resets_at: 1778285000,
      source_kind: "local-state-claude-statusline",
    });
    insertSnapshotRow(db, {
      event_id: "c",
      ts: "2026-05-08T00:20:00Z",
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 30,
      resets_at: 1778285100,
      source_kind: "local-state-claude-statusline",
    });

    const out = readSubscriptionPressure(db);
    expect(out.snapshots).toHaveLength(1);
    expect(out.snapshots[0]).toMatchObject({
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 30,
      resets_at: 1778285100,
      observed_at: "2026-05-08T00:20:00Z",
      source_kind: "local-state-claude-statusline",
    });
  });

  it("returns multiple windows for the same provider", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 1778284900,
      source_kind: "local-state-claude-statusline",
    });
    insertSnapshotRow(db, {
      event_id: "b",
      ts: "2026-05-08T00:01:00Z",
      provider: "anthropic-claude",
      window_label: "seven_day",
      used_pct: 50,
      resets_at: 1778285300,
      source_kind: "local-state-claude-statusline",
    });

    const out = readSubscriptionPressure(db);
    expect(out.snapshots.map((s) => s.window_label).sort()).toEqual(["five_hour", "seven_day"]);
  });

  it("keeps distinct snapshots for same provider/window when model differs", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "google",
      window_label: "daily",
      model: "gemini-3.1-pro-preview",
      used_pct: 20,
      resets_at: 1778284900,
      source_kind: "local-state-google-otlp-synth",
    });
    insertSnapshotRow(db, {
      event_id: "b",
      ts: "2026-05-08T00:01:00Z",
      provider: "google",
      window_label: "daily",
      model: "gemini-3-flash-preview",
      used_pct: 40,
      resets_at: 1778285000,
      source_kind: "local-state-google-otlp-synth",
    });

    const out = readSubscriptionPressure(db);
    expect(out.snapshots).toHaveLength(2);
    const models = out.snapshots.map((s) => s.model).sort();
    expect(models).toEqual(["gemini-3-flash-preview", "gemini-3.1-pro-preview"]);
  });

  it("dedupes same provider/window/model and keeps latest", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "google",
      window_label: "daily",
      model: "gemini-3.1-pro-preview",
      used_pct: 20,
      resets_at: 1778284900,
      source_kind: "local-state-google-otlp-synth",
    });
    insertSnapshotRow(db, {
      event_id: "b",
      ts: "2026-05-08T00:02:00Z",
      provider: "google",
      window_label: "daily",
      model: "gemini-3.1-pro-preview",
      used_pct: 25,
      resets_at: 1778285000,
      source_kind: "local-state-google-otlp-synth",
    });

    const out = readSubscriptionPressure(db);
    expect(out.snapshots).toHaveLength(1);
    expect(out.snapshots[0]).toMatchObject({
      provider: "google",
      window_label: "daily",
      model: "gemini-3.1-pro-preview",
      used_pct: 25,
      observed_at: "2026-05-08T00:02:00Z",
    });
  });

  it("filters snapshots by provider", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 1778284900,
      source_kind: "local-state-claude-statusline",
    });
    insertSnapshotRow(db, {
      event_id: "b",
      ts: "2026-05-08T00:01:00Z",
      provider: "openai",
      window_label: "five_hour",
      used_pct: 50,
      resets_at: 1778285300,
      source_kind: "local-state-codex-rollout",
    });

    const out = readSubscriptionPressure(db, { provider: "anthropic-claude" });
    expect(out.snapshots).toHaveLength(1);
    expect(out.snapshots[0].provider).toBe("anthropic-claude");
  });

  it("adds a stale_snapshot warning when the snapshot is older than the threshold", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 1778284900,
      source_kind: "local-state-claude-statusline",
    });

    const out = readSubscriptionPressure(db, {
      stale_after_seconds: 1800,
      now: () => new Date("2026-05-08T01:00:00Z"),
    });

    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatchObject({
      code: "stale_snapshot",
      provider: "anthropic-claude",
      window_label: "five_hour",
      age_seconds: 3600,
    });
  });

  it("stale warning carries the model dimension of its snapshot", () => {
    // Warnings must carry model so downstream stale-key comparisons match the
    // reader's snapshot group key exactly. Without model, a stale per-model
    // warning would mask a fresh global snapshot and vice versa.
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "google",
      window_label: "daily",
      model: "gemini-3.1-pro-preview",
      used_pct: 20,
      resets_at: null,
      source_kind: "local-state-google-otlp-synth",
    });
    insertSnapshotRow(db, {
      event_id: "b",
      ts: "2026-05-08T00:00:00Z",
      provider: "google",
      window_label: "daily",
      model: null,
      used_pct: 40,
      resets_at: null,
      source_kind: "local-state-google-otlp-synth",
    });

    const out = readSubscriptionPressure(db, {
      stale_after_seconds: 1800,
      now: () => new Date("2026-05-08T01:00:00Z"),
    });

    const models = new Set(
      out.warnings
        .filter((w) => w.provider === "google" && w.window_label === "daily")
        .map((w) => w.model),
    );
    expect(models).toEqual(new Set([null, "gemini-3.1-pro-preview"]));
  });

  it("does not warn when the snapshot is still fresh", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "a",
      ts: "2026-05-08T00:00:00Z",
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 1778284900,
      source_kind: "local-state-claude-statusline",
    });

    const out = readSubscriptionPressure(db, {
      stale_after_seconds: 86400,
      now: () => new Date("2026-05-08T01:00:00Z"),
    });

    expect(out.warnings).toHaveLength(0);
  });

  it("omits a window whose latest row is a retirement and emits no stale warning", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "stale-secondary",
      ts: "2026-09-02T18:23:31Z",
      provider: "openai",
      window_label: "secondary",
      used_pct: 100,
      resets_at: null,
      source_kind: "local-state-codex-rollout",
    });
    insertSnapshotRow(db, {
      event_id: "retire-secondary",
      ts: "2026-09-07T15:09:35Z",
      provider: "openai",
      window_label: "secondary",
      used_pct: 0,
      resets_at: null,
      source_kind: "local-state-codex-rollout",
      retired: true,
    });
    insertSnapshotRow(db, {
      event_id: "fresh-primary",
      ts: "2026-09-07T15:09:35Z",
      provider: "openai",
      window_label: "primary",
      used_pct: 0,
      resets_at: null,
      source_kind: "local-state-codex-rollout",
    });

    const out = readSubscriptionPressure(db, {
      stale_after_seconds: 1800,
      now: () => new Date("2026-09-07T15:10:00Z"),
    });

    expect(out.snapshots.map((s) => s.window_label).sort()).toEqual(["primary"]);
    expect(out.warnings).toEqual([]);
  });

  it("a real observation newer than a retirement resurrects the window", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "old-secondary",
      ts: "2026-09-02T18:23:31Z",
      provider: "openai",
      window_label: "secondary",
      used_pct: 100,
      resets_at: null,
      source_kind: "local-state-codex-rollout",
    });
    insertSnapshotRow(db, {
      event_id: "retire-secondary",
      ts: "2026-09-05T00:00:00Z",
      provider: "openai",
      window_label: "secondary",
      used_pct: 0,
      resets_at: null,
      source_kind: "local-state-codex-rollout",
      retired: true,
    });
    insertSnapshotRow(db, {
      event_id: "new-secondary",
      ts: "2026-09-07T00:00:00Z",
      provider: "openai",
      window_label: "secondary",
      used_pct: 12,
      resets_at: 1788826100,
      source_kind: "local-state-codex-rollout",
    });

    const out = readSubscriptionPressure(db, {
      stale_after_seconds: 86400,
      now: () => new Date("2026-09-07T01:00:00Z"),
    });

    const secondary = out.snapshots.find((s) => s.window_label === "secondary");
    expect(secondary).toMatchObject({
      provider: "openai",
      used_pct: 12,
      resets_at: 1788826100,
      observed_at: "2026-09-07T00:00:00Z",
    });
    expect(out.warnings).toEqual([]);
  });

  it("a retirement does not suppress snapshots or stale warnings for other windows", () => {
    const db = makeDb();
    insertSnapshotRow(db, {
      event_id: "retire-secondary",
      ts: "2026-09-07T15:09:35Z",
      provider: "openai",
      window_label: "secondary",
      used_pct: 0,
      resets_at: null,
      source_kind: "local-state-codex-rollout",
      retired: true,
    });
    insertSnapshotRow(db, {
      event_id: "stale-five-hour",
      ts: "2026-05-08T00:00:00Z",
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 10,
      resets_at: 1778284900,
      source_kind: "local-state-claude-statusline",
    });

    const out = readSubscriptionPressure(db, {
      stale_after_seconds: 1800,
      now: () => new Date("2026-05-08T01:00:00Z"),
    });

    expect(out.snapshots).toHaveLength(1);
    expect(out.snapshots[0]).toMatchObject({
      provider: "anthropic-claude",
      window_label: "five_hour",
      used_pct: 10,
    });
    expect(out.warnings).toEqual([
      {
        code: "stale_snapshot",
        provider: "anthropic-claude",
        window_label: "five_hour",
        model: null,
        age_seconds: 3600,
      },
    ]);
  });

  it("back-compat: row without model in payload yields model=null", () => {
    const db = makeDb();
    db.prepare(
      `
      INSERT INTO t0_events (
        event_id, ts, ingest_ts, source, user_id, machine_id,
        event_type, lane, provider, payload_json
      ) VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'rate-limit-snapshot', 'cli-subscription', ?, ?)
    `,
    ).run(
      "legacy",
      "2026-05-08T00:00:00Z",
      "2026-05-08T00:00:00Z",
      "anthropic",
      JSON.stringify({
        window_label: "five_hour",
        used_pct: 20,
        resets_at: 1778284900,
        source_kind: "legacy-reader",
      }),
    );

    const out = readSubscriptionPressure(db);
    expect(out.snapshots).toHaveLength(1);
    expect(out.snapshots[0]?.model).toBeNull();
  });
});

it("buildPressureExcludedKeys ignores warning codes outside the fail-open allowlist", () => {
  expect(
    buildPressureExcludedKeys({
      snapshots: [],
      warnings: [
        {
          code: "implausible_resets_at",
          provider: "openai",
          window_label: "secondary",
          model: null,
          age_seconds: 60,
          raw_resets_at: 3600,
        },
      ],
    }).size,
  ).toBe(0);
});

function checkReset(raw: number, ts = "2026-10-01T11:59:00Z"): ReturnType<typeof readPressure> {
  const db = makeDb();
  insertSnapshotRow(db, {
    event_id: "reset",
    ts,
    provider: "openai",
    window_label: "secondary",
    used_pct: 98,
    resets_at: raw,
    source_kind: "test",
  });
  const result = readSubscriptionPressure(db, { now: () => new Date("2026-10-01T12:00:00Z") });
  db.close();
  return result;
}

it("quarantines a far-past resets_at and keeps the fresh window live", () => {
  for (const raw of [3600, 0, -5]) {
    const result = checkReset(raw);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.resets_at).toBeNull();
    expect(result.warnings).toEqual([
      {
        code: "implausible_resets_at",
        provider: "openai",
        window_label: "secondary",
        model: null,
        age_seconds: 60,
        raw_resets_at: raw,
      },
    ]);
  }
});
it("quarantines microsecond and nanosecond resets_at", () => {
  const reset = Date.parse("2026-10-01T11:00:00Z") / 1000;
  expect([1e6, 1e9].map((scale) => checkReset(reset * scale).snapshots[0]?.resets_at)).toEqual([
    null,
    null,
  ]);
});
it("bounds reset plausibility relative to observation time inclusively", () => {
  const obsS = Date.parse("2026-10-01T11:59:00Z") / 1000;
  expect(checkReset(obsS - 366 * 86400).warnings[0]?.code).toBe("expired_window");
  expect(checkReset(obsS - 366 * 86400 - 1).warnings[0]?.code).toBe("implausible_resets_at");
  expect(checkReset(obsS + 32 * 86400).snapshots[0]?.resets_at).toBe(obsS + 32 * 86400);
  expect(checkReset(obsS + 32 * 86400 + 1).snapshots[0]?.resets_at).toBeNull();
});
it("admits a plausible elapsed reset from a ten-day-old observation", () => {
  const result = checkReset(Date.parse("2026-09-22T12:00:00Z") / 1000, "2026-09-21T12:00:00Z");
  expect(result.snapshots).toEqual([]);
  expect(result.warnings).toEqual([
    {
      code: "expired_window",
      provider: "openai",
      window_label: "secondary",
      model: null,
      age_seconds: 864000,
      expired_for_seconds: 9 * 86400,
    },
  ]);
});

it("routing view excludes expired windows while the cost view includes them flagged", () => {
  const db = makeDb();
  const now = (): Date => new Date("2026-10-01T12:00:00Z");
  insertSnapshotRow(db, {
    event_id: "expired",
    ts: "2026-10-01T11:59:00Z",
    provider: "openai",
    window_label: "daily",
    used_pct: 98,
    resets_at: Date.parse("2026-10-01T11:59:30Z") / 1000,
    source_kind: "test",
  });
  expect(readSubscriptionPressure(db, { now }).snapshots).toEqual([]);
  expect(
    readRecentSubscriptionPressureSnapshots(db, { now, since: "2026-10-01T00:00:00Z" }),
  ).toMatchObject([{ status: "expired", used_pct: 98 }]);
  db.close();
});
it("groups subscription pressure by payload_json.model, matching the routing gate", () => {
  const db = makeDb();
  insertSnapshotRow(db, {
    event_id: "divergent",
    ts: "2026-10-01T11:59:00Z",
    provider: "openai",
    model: "gpt-payload",
    window_label: "daily",
    used_pct: 98,
    resets_at: null,
    source_kind: "test",
  });
  db.run("UPDATE t0_events SET model = 'gpt-col'");
  const opts = { now: (): Date => new Date("2026-10-01T12:00:00Z"), since: "2026-10-01T00:00:00Z" };
  expect(readSubscriptionPressure(db, opts).snapshots[0]?.model).toBe("gpt-payload");
  expect(readRecentSubscriptionPressureSnapshots(db, opts)[0]?.model).toBe("gpt-payload");
  db.close();
});

it("preserves serialized stale and expired routing warnings", () => {
  const db = makeDb();
  const base = { provider: "openai", model: null, used_pct: 99, source_kind: "test" };
  insertSnapshotRow(db, {
    ...base,
    event_id: "expired-order",
    window_label: "primary",
    ts: "2026-10-01T11:59:00Z",
    resets_at: Date.parse("2026-10-01T12:00:00Z") / 1000,
  });
  insertSnapshotRow(db, {
    ...base,
    event_id: "stale-order",
    window_label: "secondary",
    ts: "2026-10-01T11:00:00Z",
    resets_at: null,
  });
  const result = readSubscriptionPressure(db, { now: () => new Date("2026-10-01T12:00:00.500Z") });
  expect(JSON.stringify(result.warnings)).toBe(
    JSON.stringify([
      {
        code: "expired_window",
        expired_for_seconds: 0.5,
        provider: "openai",
        window_label: "primary",
        model: null,
        age_seconds: 60,
      },
      {
        code: "stale_snapshot",
        provider: "openai",
        window_label: "secondary",
        model: null,
        age_seconds: 3600,
      },
    ]),
  );
  db.close();
});
