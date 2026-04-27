import { resolveDaemonStorageRoot, type ResolveDaemonStorageRootOpts } from '@penumbra/core';

export interface ResolveCliStorageRootOpts extends ResolveDaemonStorageRootOpts {
  explicit?: string;
}

export function resolveCliStorageRoot(opts: ResolveCliStorageRootOpts = {}): string {
  return resolveDaemonStorageRoot({
    ...opts,
    explicit: opts.explicit ?? process.env.PENUMBRA_STORAGE_ROOT,
  });
}
