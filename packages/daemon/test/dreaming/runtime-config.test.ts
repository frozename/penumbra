import { getConfig } from "@penumbra/config";
import { applySchema, loadSqliteVec } from "@penumbra/core";
import { buildDreamingConfig } from "@src/dreaming/config.js";
import { resolveDreamRuntimeConfig } from "@src/dreaming/runtime-config.js";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

function withDb(run: (db: Database) => void): void {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  try {
    run(db);
  } finally {
    db.close();
  }
}

describe("resolveDreamRuntimeConfig", () => {
  test("auto-resumes dreaming when enabled is defaulted off but historical cron cycles exist", () => {
    withDb((db) => {
      db.prepare(
        `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
         VALUES('cycle-1', ?, 'cron', 0.5, 'completed', '[]')`,
      ).run(Date.now() - 60_000);

      const bundle = getConfig({});
      const config = buildDreamingConfig(bundle);
      expect(config.enabled).toBe(false);

      const resolved = resolveDreamRuntimeConfig(db, bundle, config);
      expect(resolved.autoResumedFromHistory).toBe(true);
      expect(resolved.config.enabled).toBe(true);
    });
  });

  test("does not auto-resume dreaming when enabled is explicitly set to false", () => {
    withDb((db) => {
      db.prepare(
        `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
         VALUES('cycle-1', ?, 'cron', 0.5, 'completed', '[]')`,
      ).run(Date.now() - 60_000);

      const bundle = getConfig({ PENUMBRA_DREAMING_ENABLED: "0" });
      const config = buildDreamingConfig(bundle);
      expect(config.enabled).toBe(false);

      const resolved = resolveDreamRuntimeConfig(db, bundle, config);
      expect(resolved.autoResumedFromHistory).toBe(false);
      expect(resolved.config.enabled).toBe(false);
    });
  });

  test("does not auto-resume when there are no historical cron cycles", () => {
    withDb((db) => {
      const bundle = getConfig({});
      const config = buildDreamingConfig(bundle);
      expect(config.enabled).toBe(false);

      const resolved = resolveDreamRuntimeConfig(db, bundle, config);
      expect(resolved.autoResumedFromHistory).toBe(false);
      expect(resolved.config.enabled).toBe(false);
    });
  });
});
