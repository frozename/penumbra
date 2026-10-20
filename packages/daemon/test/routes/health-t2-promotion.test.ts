import { loadSqliteVec, migrate } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { healthRoute } from "@src/routes/health.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

const ENABLED_T2_STATUS = {
  enabled: true,
  reason: "judge_configured",
  judge_env: "PENUMBRA_JUDGE_BASE_URL",
} as const;

function makeDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function seedEmptyStreak(db: Database, streak: number): void {
  db.run(
    `INSERT INTO subsystem_health(subsystem, tier, consecutive_failures, updated_at)
     VALUES ('t2.promotion.empty_extraction', 'primary', ?, '2026-04-27T10:00:00Z')`,
    [streak],
  );
}

test("healthRoute omits t2Promotion when no status is supplied", async () => {
  const payload = (await healthRoute().json()) as Record<string, unknown>;

  expect(payload.status).toBe("ok");
  expect(payload.t2Promotion).toBeUndefined();
});

test("healthRoute reports the disabled t2 promotion worker with the judge env name", async () => {
  const payload = (await healthRoute({
    t2Promotion: {
      enabled: false,
      reason: "judge_unconfigured",
      judge_env: "PENUMBRA_JUDGE_BASE_URL",
    },
  }).json()) as Record<string, unknown>;

  expect(payload.t2Promotion).toEqual({
    enabled: false,
    reason: "judge_unconfigured",
    judge_env: "PENUMBRA_JUDGE_BASE_URL",
  });
});

test("healthRoute reports an enabled t2 promotion worker", async () => {
  const payload = (await healthRoute({
    t2Promotion: {
      enabled: true,
      reason: "judge_configured",
      judge_env: "PENUMBRA_JUDGE_BASE_URL",
    },
  }).json()) as Record<string, unknown>;

  expect(payload.t2Promotion).toEqual({
    enabled: true,
    reason: "judge_configured",
    judge_env: "PENUMBRA_JUDGE_BASE_URL",
  });
});

test("healthRoute reports the empty-extraction streak as healthy below 50", async () => {
  const db = makeDb();
  try {
    seedEmptyStreak(db, 3);
    const payload = (await healthRoute({ db, t2Promotion: ENABLED_T2_STATUS }).json()) as Record<
      string,
      unknown
    >;

    expect(payload.t2Promotion).toEqual({
      ...ENABLED_T2_STATUS,
      empty_extraction_streak: 3,
      healthy: true,
    });
  } finally {
    db.close();
  }
});

test("healthRoute marks t2Promotion unhealthy when the last 50 judge-reached attempts were empty", async () => {
  const db = makeDb();
  try {
    seedEmptyStreak(db, 50);
    const payload = (await healthRoute({ db, t2Promotion: ENABLED_T2_STATUS }).json()) as Record<
      string,
      unknown
    >;

    expect(payload.t2Promotion).toEqual({
      ...ENABLED_T2_STATUS,
      empty_extraction_streak: 50,
      healthy: false,
    });
  } finally {
    db.close();
  }
});

test("healthRoute reports a zero streak and healthy when no empty-extraction row exists", async () => {
  const db = makeDb();
  try {
    const payload = (await healthRoute({ db, t2Promotion: ENABLED_T2_STATUS }).json()) as Record<
      string,
      unknown
    >;

    expect(payload.t2Promotion).toEqual({
      ...ENABLED_T2_STATUS,
      empty_extraction_streak: 0,
      healthy: true,
    });
  } finally {
    db.close();
  }
});

test("healthRoute leaves a disabled t2 promotion status unenriched even with a db", async () => {
  const db = makeDb();
  try {
    seedEmptyStreak(db, 50);
    const payload = (await healthRoute({
      db,
      t2Promotion: {
        enabled: false,
        reason: "judge_unconfigured",
        judge_env: "PENUMBRA_JUDGE_BASE_URL",
      },
    }).json()) as Record<string, unknown>;

    expect(payload.t2Promotion).toEqual({
      enabled: false,
      reason: "judge_unconfigured",
      judge_env: "PENUMBRA_JUDGE_BASE_URL",
    });
  } finally {
    db.close();
  }
});
