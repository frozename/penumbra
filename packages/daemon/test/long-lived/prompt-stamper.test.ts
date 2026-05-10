import { describe, it, expect } from 'bun:test';
import { stampPrompt } from '@penumbra/daemon/long-lived/prompt-stamper';

const agent = {
  id: 'home-mgmt',
  display_name: 'Home Management',
  standing_brief: 'BRIEF',
  working_memory: { version: 1, updated_at: 0, pending_goals: [{ kind: 'user_goal', text: 'check the dryer' }], open_threads: [], watches: [], recent_decisions: [] },
  mcp_allowlist: ['ha:state.list', 'penumbra:long_lived_self_state_set'],
  bounds: { wall_clock_ms: 180000, cost_cents: 50, max_sub_dispatches: 0 },
};

describe('stampPrompt', () => {
  it('includes display_name and standing brief', () => {
    const out = stampPrompt({ agent: agent as any, tick: { id: 't1', trigger_kind: 'cron', trigger_payload: null, now_iso: '2026-05-10T00:00:00Z' } });
    expect(out).toContain('Home Management');
    expect(out).toContain('BRIEF');
  });

  it('includes pretty-printed working memory and pending goals', () => {
    const out = stampPrompt({ agent: agent as any, tick: { id: 't1', trigger_kind: 'cron', trigger_payload: null, now_iso: '2026-05-10T00:00:00Z' } });
    expect(out).toContain('check the dryer');
  });

  it('lists only allowlisted tools', () => {
    const out = stampPrompt({ agent: agent as any, tick: { id: 't1', trigger_kind: 'cron', trigger_payload: null, now_iso: '2026-05-10T00:00:00Z' } });
    expect(out).toContain('ha:state.list');
    expect(out).toContain('penumbra:long_lived_self_state_set');
    expect(out).not.toContain('ha:integration.install');
  });

  it('mentions the required FIRST/LAST protocol with self_state_set', () => {
    const out = stampPrompt({ agent: agent as any, tick: { id: 't1', trigger_kind: 'cron', trigger_payload: null, now_iso: '2026-05-10T00:00:00Z' } });
    expect(out).toMatch(/FIRST action.*long_lived_self_state_set/s);
    expect(out).toMatch(/LAST action.*long_lived_self_state_set/s);
  });

  it('includes the tick budget', () => {
    const out = stampPrompt({ agent: agent as any, tick: { id: 't1', trigger_kind: 'cron', trigger_payload: null, now_iso: '2026-05-10T00:00:00Z' } });
    expect(out).toContain('180000ms');
    expect(out).toContain('50¢');
    expect(out).toContain('0 sub-dispatches');
  });

  it('reflects trigger_kind=event and inlines payload', () => {
    const out = stampPrompt({
      agent: agent as any,
      tick: { id: 't2', trigger_kind: 'event', trigger_payload: { server: 'ha', event: 'state_changed', entity_id: 'light.kitchen' }, now_iso: 'now' },
    });
    expect(out).toContain('event');
    expect(out).toContain('light.kitchen');
  });
});
