import { describe, it, expect } from 'bun:test';
import { extractActionTarget, registerTargetExtractor } from '@penumbra/daemon/long-lived/target-extractors';

describe('target extractors', () => {
  it('returns empty string for unknown tools', () => {
    expect(extractActionTarget('unknown:tool', {})).toBe('');
  });

  it('extracts ha:automation.set target from entity_id', () => {
    expect(extractActionTarget('ha:automation.set', { entity_id: 'automation.morning_lights' })).toBe('automation.morning_lights');
  });

  it('extracts ha:integration.install target from domain', () => {
    expect(extractActionTarget('ha:integration.install', { domain: 'mqtt' })).toBe('mqtt');
  });

  it('extracts ha:dashboard.* target from path', () => {
    expect(extractActionTarget('ha:dashboard.set', { path: 'lovelace/home' })).toBe('lovelace/home');
  });

  it('honors a custom registration', () => {
    registerTargetExtractor('custom:tool', (a) => String((a as any).id ?? ''));
    expect(extractActionTarget('custom:tool', { id: 42 })).toBe('42');
  });
});
