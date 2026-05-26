import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_CONFIG_DIR = '.config/penumbra';
const LEGACY_CONFIG_DIR = '.penumbra';

const FILE_OVERRIDES: Readonly<Record<string, string>> = {
  'projects.yaml': 'PENUMBRA_PROJECTS_YAML',
  'workers.yaml': 'PENUMBRA_WORKERS_CONFIG_PATH',
};

export function resolveOperatorConfigPath(
  filename: string,
  env: Record<string, string | undefined>,
): string {
  const overrideKey = FILE_OVERRIDES[filename];
  const override = overrideKey ? env[overrideKey] : undefined;
  if (override && override.length > 0) return override;
  const baseDir = env.PENUMBRA_CONFIG_DIR && env.PENUMBRA_CONFIG_DIR.length > 0
    ? env.PENUMBRA_CONFIG_DIR
    : join(resolveHomeDir(env), DEFAULT_CONFIG_DIR);
  return join(baseDir, filename);
}

export function resolveLegacyOperatorConfigPath(
  filename: string,
  env: Record<string, string | undefined>,
): string {
  return join(resolveHomeDir(env), LEGACY_CONFIG_DIR, filename);
}

function resolveHomeDir(env: Record<string, string | undefined>): string {
  return env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
}
