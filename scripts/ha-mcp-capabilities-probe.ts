#!/usr/bin/env bun
/**
 * ha-mcp capabilities probe (read-only)
 *
 * Run against a saved ha-mcp tools/list response to verify which tools the
 * home-management long-lived agent will be able to use.
 *
 * Usage:
 *   bun scripts/ha-mcp-capabilities-probe.ts <ha-mcp-tools-listing.json>
 *
 * Where <ha-mcp-tools-listing.json> is the result of calling the ha-mcp
 * `tools/list` MCP method (one entry per tool, with a `name` field). Save the
 * listing to a file and pass the path.
 *
 * Output: JSON with { required, present, missing }.
 */

// Aligned to ha-mcp v7.x tool names (homeassistant-ai/ha-mcp). All tools are
// `ha_*` prefixed; light/switch/climate/script control all go through the
// generic `ha_call_service` and `ha_bulk_control` rather than per-domain tools.
const REQUIRED_TOOLS = [
  // Search / discovery
  'ha_search_entities', 'ha_get_overview', 'ha_get_state',
  // Generic service call (covers script.run, light/switch toggles, climate)
  'ha_call_service', 'ha_bulk_control',
  // Automations (read + write + remove)
  'ha_config_get_automation', 'ha_config_set_automation', 'ha_config_remove_automation',
  // Dashboards (read + write)
  'ha_config_get_dashboard', 'ha_config_set_dashboard',
  // Backups (the v7 equivalent of "snapshot")
  'ha_backup_create', 'ha_backup_restore',
  // Diagnostics — automation traces, logs, system health
  'ha_get_automation_traces', 'ha_get_logs', 'ha_get_system_health',
];

const path = process.argv[2];
if (!path) {
  console.error('Usage: bun scripts/ha-mcp-capabilities-probe.ts <ha-mcp-tools.json>');
  process.exit(2);
}

const raw = await Bun.file(path).text();
const parsed = JSON.parse(raw) as { tools?: Array<{ name: string }> } | Array<{ name: string }>;
const list = Array.isArray(parsed) ? parsed : parsed.tools ?? [];
const have = new Set(list.map((t) => t.name));
const present = REQUIRED_TOOLS.filter((t) => have.has(t));
const missing = REQUIRED_TOOLS.filter((t) => !have.has(t));

console.log(JSON.stringify({
  required: REQUIRED_TOOLS,
  present,
  missing,
}, null, 2));
process.exit(missing.length === 0 ? 0 : 1);

export {};
