export interface AssertDiscoveryNotSuspiciouslyEmptyOptions {
  /**
   * An independent confirmation that the discovery source itself is
   * legitimately empty (e.g. "the node inventory has zero nodes", not just
   * "zero models were parsed out of a healthy node"). When it returns true,
   * an empty result is treated as authoritative.
   */
  controlCheck?: () => boolean;
}

/**
 * Guards a config generator against treating a broken or empty discovery
 * probe as authoritative. Without this, an empty result would flow straight
 * into the prune step and delete every generator-owned seat. Throws unless
 * the result is non-empty, or an empty result is confirmed by a passing
 * `controlCheck` — callers should catch the throw and produce a no-change
 * result instead of proceeding to prune.
 */
export function assertDiscoveryNotSuspiciouslyEmpty(
  result: readonly unknown[],
  opts: AssertDiscoveryNotSuspiciouslyEmptyOptions = {},
): void {
  if (result.length > 0) return;
  if (opts.controlCheck?.()) return;
  throw new Error(
    "discovery returned zero results with no paired control confirmation; refusing to treat this as authoritative (would prune every generator-owned seat)",
  );
}
