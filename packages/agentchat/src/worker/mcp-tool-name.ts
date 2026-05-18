/**
 * Translate a yaml mcp_allowlist entry to the SDK-exposed tool name form
 * ("mcp__ha__ha_pulse"). Both colon-form ("ha:ha_pulse") and dot-form
 * ("ha.ha_pulse") are accepted; non-mcp entries pass through unchanged so
 * existing plain tool names (Bash, Read, etc.) work as before.
 */
export function colonFormToSdkPattern(entry: string): string {
  const separator = entry.includes(':') ? entry.indexOf(':') : entry.indexOf('.');
  if (separator < 0) return entry;
  const server = entry.slice(0, separator);
  const tool = entry.slice(separator + 1);
  return `mcp__${server}__${tool}`;
}
