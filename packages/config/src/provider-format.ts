/**
 * Canonical provider-value format for routing biases.
 *
 * Routing-bias matching (`resolveBiasEffect` in @penumbra/core agent-routing
 * and its deliberate mirror `isBiasExcluded` in agentchat's
 * silent-failure-retry.ts) compares a bias's `value` against an agent's resolved
 * provider with strict `===`. There is intentionally NO normalization at match
 * time: the retry selector mirrors the daemon scorer byte-for-byte, so
 * normalizing one side would silently drift the two apart.
 *
 * The invariant that makes strict-equality matching correct is enforced at the
 * WRITE boundaries instead — config load (the agent `api_provider` /
 * `subscription_provider` schema in files/agents.ts, which the DAEMON scorer
 * consumes) and bias creation (the daemon `routing_bias_set` route + the MCP
 * tool, scope "provider"). Each rejects a non-canonical value, so a provider
 * value can never enter the system in a form that strict-`===` would silently
 * fail to match (e.g. "OpenAI" vs "openai", "nvidia_nim" vs "nvidia-nim").
 *
 * This lives in @penumbra/config (a leaf package) rather than @penumbra/core
 * because the daemon-consumed config schema (files/agents.ts) must reference it,
 * and @penumbra/core already depends on @penumbra/config — putting it in core
 * would be a dependency cycle.
 *
 * Canonical = lowercase alphanumerics in hyphen-separated segments, e.g.
 * "openai", "anthropic", "nvidia-nim", "opencode-go".
 */
export const CANONICAL_PROVIDER_VALUE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True when `value` is a canonical provider value (see CANONICAL_PROVIDER_VALUE_RE). */
export function isCanonicalProviderValue(value: string): boolean {
  return CANONICAL_PROVIDER_VALUE_RE.test(value);
}
