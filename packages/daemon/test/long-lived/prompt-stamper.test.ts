import { expect, test } from 'bun:test';
import { stampPrompt, type StampInputAgent, type StampInputTick } from '../../src/long-lived/prompt-stamper.js';

const baseTick: StampInputTick = { id: 't1', trigger_kind: 'cron', trigger_payload: null, now_iso: '2026-05-18T00:00:00Z' };
const baseAgent: StampInputAgent = {
  id: 'home-mgmt',
  display_name: 'Home Mgmt',
  standing_brief: 'test',
  working_memory: { pending_goals: [], open_threads: [], observations: [], watches: [] } as any,
  mcp_allowlist: ['ha:ha_pulse'],
  bounds: { wall_clock_ms: 360000, cost_cents: 50, max_sub_dispatches: 3 },
};

test('no unavailable_servers produces no unavailability section', () => {
  const prompt = stampPrompt({ agent: { ...baseAgent, unavailable_servers: [] }, tick: baseTick });
  expect(prompt).not.toContain('unavailable this tick');
});

test('one unavailable server produces explicit warning', () => {
  const prompt = stampPrompt({ agent: { ...baseAgent, unavailable_servers: ['ha'] }, tick: baseTick });
  expect(prompt).toContain("MCP server 'ha' is unavailable this tick");
  expect(prompt).toContain('proceed without');
});

test('multiple unavailable servers are each listed', () => {
  const prompt = stampPrompt({ agent: { ...baseAgent, unavailable_servers: ['ha', 'other'] }, tick: baseTick });
  expect(prompt).toContain("'ha'");
  expect(prompt).toContain("'other'");
});

test('unavailable_servers omitted behaves the same as empty', () => {
  const prompt = stampPrompt({ agent: baseAgent, tick: baseTick });
  expect(prompt).not.toContain('unavailable this tick');
});
