import { describe, it, expect } from 'bun:test';
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

describe('stampPrompt', () => {
  it('includes display_name and standing brief', () => {
    const out = stampPrompt({ agent: baseAgent, tick: baseTick });
    expect(out).toContain('Home Mgmt');
    expect(out).toContain('test');
  });

  it('includes pretty-printed working memory and pending goals', () => {
    const agent: StampInputAgent = {
      ...baseAgent,
      working_memory: {
        pending_goals: [{ kind: 'user_goal', text: 'check the dryer' }],
        open_threads: [],
        observations: [],
        watches: [],
      } as any,
    };
    const out = stampPrompt({ agent, tick: baseTick });
    expect(out).toContain('check the dryer');
  });

  it('lists only allowlisted tools', () => {
    const out = stampPrompt({
      agent: {
        ...baseAgent,
        mcp_allowlist: ['ha:state.list', 'penumbra:long_lived_self_state_set'],
      },
      tick: baseTick,
    });
    expect(out).toContain('ha:state.list');
    expect(out).toContain('penumbra:long_lived_self_state_set');
    expect(out).not.toContain('ha:integration.install');
  });

  it('includes dispatch-envelope instructions when chain_start is allowlisted', () => {
    const out = stampPrompt({
      agent: {
        ...baseAgent,
        mcp_allowlist: ['penumbra:chain_start', 'penumbra:long_lived_self_state_set'],
      },
      tick: { ...baseTick, id: 'tick-99' },
    });
    expect(out).toContain('Dispatching sub-chains from this tick:');
    expect(out).toContain('dispatch_kind: "long_lived_tick"');
    expect(out).toContain('long_lived_tick_id: "tick-99"');
    expect(out).toContain('long_lived_agent_id: "home-mgmt"');
  });

  it('omits dispatch-envelope instructions when chain_start is not allowlisted', () => {
    const out = stampPrompt({
      agent: {
        ...baseAgent,
        mcp_allowlist: ['penumbra:long_lived_self_state_set'],
      },
      tick: { ...baseTick, id: 'tick-99' },
    });
    expect(out).not.toContain('Dispatching sub-chains from this tick:');
    expect(out).not.toContain('long_lived_tick_id: "tick-99"');
  });

  it('mentions the required FIRST/LAST protocol with self_state_set', () => {
    const out = stampPrompt({ agent: baseAgent, tick: baseTick });
    expect(out).toMatch(/FIRST action.*long_lived_self_state_set/s);
    expect(out).toMatch(/LAST action.*long_lived_self_state_set/s);
  });

  it('includes the tick budget', () => {
    const out = stampPrompt({ agent: baseAgent, tick: baseTick });
    expect(out).toContain('360000ms');
    expect(out).toContain('50¢');
    expect(out).toContain('3 sub-dispatches');
  });

  it('reflects trigger_kind=event and inlines payload', () => {
    const out = stampPrompt({
      agent: baseAgent,
      tick: { id: 't2', trigger_kind: 'event', trigger_payload: { server: 'ha', event: 'state_changed', entity_id: 'light.kitchen' }, now_iso: 'now' },
    });
    expect(out).toContain('event');
    expect(out).toContain('light.kitchen');
  });

  it('does not render an unavailability section when no servers are unavailable', () => {
    const out = stampPrompt({ agent: { ...baseAgent, unavailable_servers: [] }, tick: baseTick });
    expect(out).not.toContain('unavailable this tick');
  });

  it('renders a warning for an unavailable server', () => {
    const out = stampPrompt({ agent: { ...baseAgent, unavailable_servers: ['ha'] }, tick: baseTick });
    expect(out).toContain("MCP server 'ha' is unavailable this tick");
    expect(out).toContain('proceed without them');
  });

  it('lists multiple unavailable servers', () => {
    const out = stampPrompt({ agent: { ...baseAgent, unavailable_servers: ['ha', 'other'] }, tick: baseTick });
    expect(out).toContain("'ha'");
    expect(out).toContain("'other'");
  });

  it('treats omitted unavailable_servers like empty', () => {
    const out = stampPrompt({ agent: baseAgent, tick: baseTick });
    expect(out).not.toContain('unavailable this tick');
  });
});
