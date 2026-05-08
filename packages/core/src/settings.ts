import { z } from 'zod';

export const SettingsSchema = z.object({
  t0RetentionDays: z.number().int().positive().default(30),
  t1RollupIntervalSec: z.number().int().positive().default(60),
  t1SessionIdleMinutes: z.number().int().positive().default(10),
  t2PromotionDelayHours: z.number().int().nonnegative().default(24),
  backupRetentionDays: z.number().int().positive().default(7),
  // Intentionally conservative for first deployment. Operator can flip false
  // after inspecting one dry-run tick.
  prOrphanSweeperDryRun: z.boolean().default(true),
  prOrphanSweeperIntervalMs: z.number().int().positive().default(21_600_000),
  dreamModeStrategy: z.enum(['embersynth', 'local', 'skip']).default('local'),
  embedderPreferSirius: z.boolean().default(true),
  reconcileTypecheckTimeoutSec: z.number().positive().default(120),
  reconcileTestTimeoutSec: z.number().positive().default(300),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsInput = Partial<Settings>;

const envKeyFor: Record<keyof Settings, string> = {
  t0RetentionDays: 'PENUMBRA_T0_RETENTION_DAYS',
  t1RollupIntervalSec: 'PENUMBRA_T1_ROLLUP_INTERVAL_SEC',
  t1SessionIdleMinutes: 'PENUMBRA_T1_SESSION_IDLE_MINUTES',
  t2PromotionDelayHours: 'PENUMBRA_T2_PROMOTION_DELAY_HOURS',
  backupRetentionDays: 'PENUMBRA_BACKUP_RETENTION_DAYS',
  prOrphanSweeperDryRun: 'PENUMBRA_PR_ORPHAN_SWEEPER_DRY_RUN',
  prOrphanSweeperIntervalMs: 'PENUMBRA_PR_ORPHAN_SWEEPER_INTERVAL_MS',
  dreamModeStrategy: 'PENUMBRA_DREAM_MODE_STRATEGY',
  embedderPreferSirius: 'PENUMBRA_EMBEDDER_PREFER_SIRIUS',
  reconcileTypecheckTimeoutSec: 'PENUMBRA_RECONCILE_TYPECHECK_TIMEOUT_S',
  reconcileTestTimeoutSec: 'PENUMBRA_RECONCILE_TEST_TIMEOUT_S',
};

const parsers: Record<keyof Settings, (raw: string) => unknown> = {
  t0RetentionDays: Number,
  t1RollupIntervalSec: Number,
  t1SessionIdleMinutes: Number,
  t2PromotionDelayHours: Number,
  backupRetentionDays: Number,
  prOrphanSweeperDryRun: (s) => s === 'true' || s === '1',
  prOrphanSweeperIntervalMs: Number,
  dreamModeStrategy: (s) => s,
  embedderPreferSirius: (s) => s === 'true' || s === '1',
  reconcileTypecheckTimeoutSec: Number,
  reconcileTestTimeoutSec: Number,
};

export const SettingsDefaults = {
  build(opts: { env: NodeJS.ProcessEnv; input: SettingsInput }): Settings {
    return this.buildWithWarnings(opts).settings;
  },

  buildWithWarnings(opts: {
    env: NodeJS.ProcessEnv;
    input: SettingsInput;
  }): { settings: Settings; warnings: string[] } {
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
