import { formatEnvConfig, getConfig } from '@penumbra/config';

export interface ConfigShowOpts {
  json: boolean;
}

export async function runConfigShow(opts: ConfigShowOpts): Promise<void> {
  const bundle = getConfig();
  const output = formatEnvConfig(bundle, { json: opts.json });
  process.stdout.write(output);
  process.stdout.write('\n');
}
