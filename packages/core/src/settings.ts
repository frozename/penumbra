import { z } from "zod";

export const SettingsSchema = z.object({
  t0RetentionDays: z.number().int().positive().default(30),
  // dispatch_events is high-volume operational telemetry (~95% heartbeats) with
  // no rollup; prune it on its own (shorter) horizon so it doesn't grow unbounded.
  dispatchEventsRetentionDays: z.number().int().positive().default(14),
  sessionEventsRetentionDays: z.number().int().positive().default(180),
  t1RollupIntervalSec: z.number().int().positive().default(60),
  t1SessionIdleMinutes: z.number().int().positive().default(10),
  t2PromotionDelayHours: z.number().int().nonnegative().default(24),
  backupRetentionDays: z.number().int().positive().default(7),
  // Intentionally conservative for first deployment. Operator can flip false
  // after inspecting one dry-run tick.
  prOrphanSweeperDryRun: z.boolean().default(true),
  prOrphanSweeperIntervalMs: z.number().int().positive().default(21_600_000),
  laneOrphanSweeperGraceMinutes: z.number().int().positive().default(120),
  laneOrphanSweeperNonTrivialGraceMinutes: z.number().int().positive().default(1440),
  // gh-task-sync drains the gh_outbox every tick; the heavy full reconcile
  // (listLinkedTasks → per-task GitHub pull/drift correction) only runs this
  // often. Default 5min: status pushes stay prompt via the outbox, pulls lag ≤5min.
  ghTaskSyncFullReconcileIntervalMs: z.number().int().positive().default(300_000),
  dreamModeStrategy: z.enum(["embersynth", "local", "skip"]).default("local"),
  reconcileTypecheckTimeoutSec: z.number().positive().default(120),
  reconcileTestTimeoutSec: z.number().positive().default(300),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsInput = Partial<Settings>;

const envKeyFor: Record<keyof Settings, string> = {
  t0RetentionDays: "PENUMBRA_T0_RETENTION_DAYS",
  dispatchEventsRetentionDays: "PENUMBRA_DISPATCH_EVENTS_RETENTION_DAYS",
  sessionEventsRetentionDays: "PENUMBRA_SESSION_EVENTS_RETENTION_DAYS",
  t1RollupIntervalSec: "PENUMBRA_T1_ROLLUP_INTERVAL_SEC",
  t1SessionIdleMinutes: "PENUMBRA_T1_SESSION_IDLE_MINUTES",
  t2PromotionDelayHours: "PENUMBRA_T2_PROMOTION_DELAY_HOURS",
  backupRetentionDays: "PENUMBRA_BACKUP_RETENTION_DAYS",
  prOrphanSweeperDryRun: "PENUMBRA_PR_ORPHAN_SWEEPER_DRY_RUN",
  prOrphanSweeperIntervalMs: "PENUMBRA_PR_ORPHAN_SWEEPER_INTERVAL_MS",
  laneOrphanSweeperGraceMinutes: "PENUMBRA_LANE_ORPHAN_SWEEPER_GRACE_MINUTES",
  laneOrphanSweeperNonTrivialGraceMinutes: "PENUMBRA_LANE_ORPHAN_SWEEPER_NON_TRIVIAL_GRACE_MINUTES",
  ghTaskSyncFullReconcileIntervalMs: "PENUMBRA_GH_TASK_SYNC_FULL_RECONCILE_INTERVAL_MS",
  dreamModeStrategy: "PENUMBRA_DREAM_MODE_STRATEGY",
  reconcileTypecheckTimeoutSec: "PENUMBRA_RECONCILE_TYPECHECK_TIMEOUT_S",
  reconcileTestTimeoutSec: "PENUMBRA_RECONCILE_TEST_TIMEOUT_S",
};

const parsers: Record<keyof Settings, (raw: string) => unknown> = {
  t0RetentionDays: Number,
  dispatchEventsRetentionDays: Number,
  sessionEventsRetentionDays: Number,
  t1RollupIntervalSec: Number,
  t1SessionIdleMinutes: Number,
  t2PromotionDelayHours: Number,
  backupRetentionDays: Number,
  prOrphanSweeperDryRun: (s) => s === "true" || s === "1",
  prOrphanSweeperIntervalMs: Number,
  laneOrphanSweeperGraceMinutes: Number,
  laneOrphanSweeperNonTrivialGraceMinutes: Number,
  ghTaskSyncFullReconcileIntervalMs: Number,
  dreamModeStrategy: (s) => s,
  reconcileTypecheckTimeoutSec: Number,
  reconcileTestTimeoutSec: Number,
};

export const SettingsDefaults = {
  build(opts: { env: NodeJS.ProcessEnv; input: SettingsInput }): Settings {
    return this.buildWithWarnings(opts).settings;
  },

  buildWithWarnings(opts: { env: NodeJS.ProcessEnv; input: SettingsInput }): {
    settings: Settings;
    warnings: string[];
  } {
    const warnings: string[] = [];
    const merged: Record<string, unknown> = {};
    for (const key of Object.keys(envKeyFor) as (keyof Settings)[]) {
      const envVar = envKeyFor[key];
      const raw = opts.env[envVar];
      if (raw !== undefined) {
        const parsed = parsers[key](raw);
        const check = SettingsSchema.shape[key].safeParse(parsed);
        if (check.success) merged[key] = check.data;
        else warnings.push(`invalid ${envVar}=${raw}, using default`);
      }
    }
    const settings = SettingsSchema.parse({ ...merged, ...opts.input });
    return { settings, warnings };
  },
};
