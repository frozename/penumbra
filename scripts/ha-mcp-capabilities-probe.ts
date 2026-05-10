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

const REQUIRED_TOOLS = [
  'state.list', 'state.get',
  'script.run',
  'light.toggle', 'light.set', 'switch.toggle',
  'climate.set_temperature',
  'automation.list', 'automation.get', 'automation.set', 'automation.delete',
  'dashboard.list', 'dashboard.get', 'dashboard.set',
  'snapshot.create', 'snapshot.list', 'snapshot.restore',
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
