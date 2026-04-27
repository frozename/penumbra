import { z } from 'zod';

export const SettingsSchema = z.object({
  t0RetentionDays: z.number().int().positive().default(30),
  t1RollupIntervalSec: z.number().int().positive().default(60),
  t1SessionIdleMinutes: z.number().int().positive().default(10),
  t2PromotionDelayHours: z.number().int().nonnegative().default(24),
  backupRetentionDays: z.number().int().positive().default(7),
  dreamModeStrategy: z.enum(['embersynth', 'local', 'skip']).default('local'),
  embedderPreferSirius: z.boolean().default(true),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsInput = Partial<Settings>;

const envKeyFor: Record<keyof Settings, string> = {
  t0RetentionDays: 'PENUMBRA_T0_RETENTION_DAYS',
  t1RollupIntervalSec: 'PENUMBRA_T1_ROLLUP_INTERVAL_SEC',
  t1SessionIdleMinutes: 'PENUMBRA_T1_SESSION_IDLE_MINUTES',
  t2PromotionDelayHours: 'PENUMBRA_T2_PROMOTION_DELAY_HOURS',
  backupRetentionDays: 'PENUMBRA_BACKUP_RETENTION_DAYS',
  dreamModeStrategy: 'PENUMBRA_DREAM_MODE_STRATEGY',
  embedderPreferSirius: 'PENUMBRA_EMBEDDER_PREFER_SIRIUS',
};

const parsers: Record<keyof Settings, (raw: string) => unknown> = {
  t0RetentionDays: Number,
  t1RollupIntervalSec: Number,
  t1SessionIdleMinutes: Number,
  t2PromotionDelayHours: Number,
  backupRetentionDays: Number,
  dreamModeStrategy: (s) => s,
  embedderPreferSirius: (s) => s === 'true' || s === '1',
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
