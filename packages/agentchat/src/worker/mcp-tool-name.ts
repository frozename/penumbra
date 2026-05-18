/**
 * Translate a yaml mcp_allowlist entry from colon-form ("ha:ha_pulse") to the
 * SDK-exposed tool name form ("mcp__ha__ha_pulse"). Non-colon entries pass
 * through unchanged so existing plain tool names (Bash, Read, etc.) work as before.
 */
export function colonFormToSdkPattern(entry: string): string {
  const colon = entry.indexOf(':');
  if (colon < 0) return entry;
  const server = entry.slice(0, colon);
  const tool = entry.slice(colon + 1);
  return `mcp__${server}__${tool}`;
}
