import type { SiriusEmbedderOpts } from '@penumbra/core';

const KEYS = [
  'PENUMBRA_SIRIUS_BASE_URL',
  'PENUMBRA_SIRIUS_TOKEN',
  'PENUMBRA_SIRIUS_MODEL',
  'PENUMBRA_SIRIUS_DIM',
] as const;

/**
 * Read PENUMBRA_SIRIUS_* env vars and assemble SiriusEmbedderOpts.
 * Returns undefined if any of the four required vars are missing —
 * resolveEmbedder will then cleanly fall back to the bundled embedder.
 * Throws RangeError if PENUMBRA_SIRIUS_DIM is set but not a positive integer.
 */
export function readSiriusEnv(env: Record<string, string | undefined>): SiriusEmbedderOpts | undefined {
  for (const k of KEYS) {
    if (!env[k]) return undefined;
  }
  const dimRaw = env.PENUMBRA_SIRIUS_DIM!;
  const dim = Number(dimRaw);
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new RangeError(`PENUMBRA_SIRIUS_DIM must be a positive integer, got '${dimRaw}'`);
  }
  return {
    baseUrl: env.PENUMBRA_SIRIUS_BASE_URL!,
    token: env.PENUMBRA_SIRIUS_TOKEN!,
    model: env.PENUMBRA_SIRIUS_MODEL!,
    dim,
  };
}
