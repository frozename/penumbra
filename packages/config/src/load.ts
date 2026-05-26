import { ENV_REGISTRY, parseEnv, type EnvConfig } from './env.js';

export type ConfigSource = 'explicit' | 'default';

export interface ConfigBundle {
  env: EnvConfig;
  sources: Readonly<Record<string, ConfigSource>>;
}

let cached: ConfigBundle | null = null;

function buildSources(env: NodeJS.ProcessEnv): Readonly<Record<string, ConfigSource>> {
  const sources: Record<string, ConfigSource> = {};
  for (const key of Object.keys(ENV_REGISTRY)) {
    const raw = env[key];
    sources[key] = typeof raw === 'string' && raw.length > 0 ? 'explicit' : 'default';
  }
  return Object.freeze(sources);
}

export function getConfig(env?: NodeJS.ProcessEnv): ConfigBundle {
  if (env === undefined && cached) return cached;

  const resolvedEnv = parseEnv(env ?? process.env);
  const bundle: ConfigBundle = {
    env: Object.freeze(resolvedEnv),
    sources: buildSources(env ?? process.env),
  };
  const frozen = Object.freeze(bundle);

  if (env === undefined) cached = frozen;
  return frozen;
}

export function resetConfigForTest(): void {
  cached = null;
}
