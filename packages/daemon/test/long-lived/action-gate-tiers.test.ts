import { describe, it, expect } from 'bun:test';
import { classifyTier } from '@penumbra/daemon/long-lived/action-gate';

describe('classifyTier (canary baseline)', () => {
  it('ha:light.* is tier 1', () => {
    expect(classifyTier({ tool: 'ha:light.toggle', target: 'light.kitchen', agentGlobs: [] })).toBe(1);
  });
  it('ha:automation.set is tier 2', () => {
    expect(classifyTier({ tool: 'ha:automation.set', target: 'automation.x', agentGlobs: [] })).toBe(2);
  });
  it('ha:integration.install is tier 3', () => {
    expect(classifyTier({ tool: 'ha:integration.install', target: 'mqtt', agentGlobs: [] })).toBe(3);
  });
  it('agent glob can bump tier 2 to tier 3', () => {
    expect(classifyTier({
      tool: 'ha:automation.set', target: 'automation.safety/lockup',
      agentGlobs: ['ha:automation.*:safety/*'],
    })).toBe(3);
  });
  it('agent glob can bump tier 1 to tier 3', () => {
    expect(classifyTier({
      tool: 'ha:script.run', target: 'script.dangerous',
      agentGlobs: ['ha:script.run:script.dangerous'],
    })).toBe(3);
  });
  it('unknown tools fall through to tier 1 (allowlist already gated them)', () => {
    expect(classifyTier({ tool: 'custom:tool', target: 'x', agentGlobs: [] })).toBe(1);
  });
});
