import { expect, test } from "bun:test";
import { SettingsDefaults, type SettingsInput } from "../src/settings.js";

test("returns defaults when nothing is overridden", () => {
  const env: NodeJS.ProcessEnv = {};
  const s = SettingsDefaults.build({ env, input: {} });
  expect(s.t0RetentionDays).toBe(30);
  expect(s.t1RollupIntervalSec).toBe(60);
  expect(s.t1SessionIdleMinutes).toBe(10);
  expect(s.backupRetentionDays).toBe(7);
  expect(s.prOrphanSweeperDryRun).toBe(true);
  expect(s.prOrphanSweeperIntervalMs).toBe(21_600_000);
  expect(s.reconcileTypecheckTimeoutSec).toBe(120);
  expect(s.reconcileTestTimeoutSec).toBe(300);
});

test("env var override beats default", () => {
  const env: NodeJS.ProcessEnv = {
    PENUMBRA_T0_RETENTION_DAYS: "30",
    PENUMBRA_RECONCILE_TYPECHECK_TIMEOUT_S: "45",
    PENUMBRA_RECONCILE_TEST_TIMEOUT_S: "90",
  };
  const s = SettingsDefaults.build({ env, input: {} });
  expect(s.t0RetentionDays).toBe(30);
  expect(s.reconcileTypecheckTimeoutSec).toBe(45);
  expect(s.reconcileTestTimeoutSec).toBe(90);
});

test("explicit input beats env var", () => {
  const env: NodeJS.ProcessEnv = { PENUMBRA_T0_RETENTION_DAYS: "30" };
  const input: SettingsInput = { t0RetentionDays: 5 };
  const s = SettingsDefaults.build({ env, input });
  expect(s.t0RetentionDays).toBe(5);
});

test("invalid env var number falls back to default and is reported", () => {
  const env: NodeJS.ProcessEnv = { PENUMBRA_T0_RETENTION_DAYS: "banana" };
  const { settings, warnings } = SettingsDefaults.buildWithWarnings({ env, input: {} });
  expect(settings.t0RetentionDays).toBe(30);
  expect(warnings[0]).toMatch(/PENUMBRA_T0_RETENTION_DAYS/);
});
