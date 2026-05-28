import { formatEnvConfig, getConfig } from "@penumbra/config";

export interface ConfigShowOpts {
  json: boolean;
}

// Note: this command reflects the *invoking process's* environment, not the
// running daemon's runtime config. If the daemon was launched with different
// env vars (e.g. from launchd), use this command in a shell with the same
// environment to compare. A daemon-side introspection endpoint is a separate
// follow-up.
export async function runConfigShow(opts: ConfigShowOpts): Promise<void> {
  let bundle;
  try {
    bundle = getConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`penumbra config show: env validation failed\n${message}\n`);
    process.exit(1);
  }
  const output = formatEnvConfig(bundle, { json: opts.json });
  process.stdout.write(output + "\n");
}
