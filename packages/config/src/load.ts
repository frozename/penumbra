import { ENV_REGISTRY, parseEnv, type EnvConfig } from "./env.js";

export type ConfigSource = "explicit" | "default";

export interface ConfigBundle {
  env: EnvConfig;
  sources: Readonly<Record<string, ConfigSource>>;
}

let cached: ConfigBundle | null = null;

function buildSources(env: NodeJS.ProcessEnv): Readonly<Record<string, ConfigSource>> {
  const sources: Record<string, ConfigSource> = {};
  for (const key of Object.keys(ENV_REGISTRY)) {
    // Classify by key presence in the raw env, not by truthiness. An operator
    // who exports KEY='' has explicitly opted out of the default; we must
    // surface that as 'explicit' so provenance reflects intent.
    sources[key] = key in env ? "explicit" : "default";
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
